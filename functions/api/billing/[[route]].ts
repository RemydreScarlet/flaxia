import Stripe from 'stripe';

type Env = {
  DB: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  BASE_URL: string;
};

function getStripe(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2026-08-26.dahlia',
    httpClient: Stripe.createFetchHttpClient(),
  });
}

function getSessionToken(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';').map((c) => c.trim());
  const sessionCookie = cookies.find((c) => c.startsWith('session='));
  return sessionCookie ? sessionCookie.substring('session='.length) : null;
}

async function getUserId(env: Env, request: Request): Promise<string | null> {
  const token = getSessionToken(request);
  if (!token) return null;
  const session = await env.DB.prepare('SELECT user_id FROM sessions WHERE id = ?')
    .bind(token)
    .first<{ user_id: string }>();
  return session?.user_id ?? null;
}

export async function onRequest(context: {
  request: Request;
  env: Record<string, unknown>;
  waitUntil(p: Promise<unknown>): void;
}) {
  const env = context.env as unknown as Env;
  const url = new URL(context.request.url);
  const method = context.request.method;
  const path = url.pathname.replace(/^\/api\/billing\//, '');

  if (method === 'POST' && path === 'checkout') {
    return handleCheckout(context.request, env);
  }

  if (method === 'POST' && path === 'webhook') {
    return handleWebhook(context.request, env, context.waitUntil);
  }

  if (method === 'GET' && path === 'plan') {
    return handleGetPlan(context.request, env);
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PLAN_CONFIG: Record<string, { priceMonthly: number; priceYearly?: number; name: string }> = {
  flaxia_plus: { priceMonthly: 150, name: 'Flaxia+' },
  flaxia_plus_plus: { priceMonthly: 500, name: 'Flaxia++' },
  flaxia_sharp: { priceMonthly: 1000, name: 'Flaxia#' },
};

async function handleCheckout(request: Request, env: Env): Promise<Response> {
  const userId = await getUserId(env, request);
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = (await request.json()) as { planId?: string; mode?: string };
  const { planId, mode = 'subscription' } = body;

  if (!planId || !PLAN_CONFIG[planId]) {
    return new Response(JSON.stringify({ error: 'Invalid plan' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const plan = PLAN_CONFIG[planId];

  // Get or create Stripe customer
  const existingSub = await env.DB.prepare(
    'SELECT stripe_customer_id FROM subscriptions WHERE user_id = ? AND stripe_customer_id IS NOT NULL LIMIT 1',
  )
    .bind(userId)
    .first<{ stripe_customer_id: string }>();

  let customerId = existingSub?.stripe_customer_id;

  if (!customerId) {
    const user = await env.DB.prepare('SELECT email, username FROM users WHERE id = ?')
      .bind(userId)
      .first<{ email: string; username: string }>();

    const stripe = getStripe(env);
    const customer = await stripe.customers.create({
      email: user?.email,
      metadata: { flaxia_user_id: userId, username: user?.username || '' },
    });
    customerId = customer.id;
  }

  const stripe = getStripe(env);
  const baseUrl = env.BASE_URL || 'https://flaxia.app';

  if (mode === 'subscription') {
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [
        {
          price_data: {
            currency: 'jpy',
            product_data: {
              name: `${plan.name} - Flaxia Monthly`,
              metadata: { plan_id: planId },
            },
            unit_amount: plan.priceMonthly,
            recurring: { interval: 'month' },
          },
          quantity: 1,
        },
      ],
      success_url: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/billing/canceled`,
      metadata: { user_id: userId, plan_id: planId },
    });

    // Record pending transaction
    await env.DB.prepare(
      `INSERT INTO transactions (id, user_id, stripe_session_id, type, plan_id, amount, currency, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stripe_session_id) DO NOTHING`,
    )
      .bind(crypto.randomUUID(), userId, session.id, 'subscription', planId, plan.priceMonthly, 'jpy', 'pending')
      .run();

    return new Response(JSON.stringify({ sessionId: session.id, url: session.url }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Invalid mode' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleWebhook(request: Request, env: Env, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return new Response(JSON.stringify({ error: 'Missing signature' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let event: Stripe.Event;
  try {
    const rawBody = await request.text();
    const stripe = getStripe(env);
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(JSON.stringify({ error: `Webhook signature verification failed: ${message}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  waitUntil(processWebhookEvent(event, env));

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function processWebhookEvent(event: Stripe.Event, env: Env): Promise<void> {
  try {
    const stripe = getStripe(env);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.user_id;
        const sessionType = session.metadata?.type;

        if (sessionType === 'marketplace') {
          // Marketplace one-time payment completed
          const postId = session.metadata?.post_id;
          if (!userId || !postId) break;

          if (session.payment_intent && typeof session.payment_intent === 'string') {
            await env.DB.prepare(
              `UPDATE transactions SET status = 'completed', stripe_payment_intent_id = ?
               WHERE stripe_session_id = ? AND status = 'pending'`,
            )
              .bind(session.payment_intent, session.id)
              .run();
          }
          break;
        }

        // Subscription checkout completed
        const planId = session.metadata?.plan_id;
        if (!userId || !planId) break;

        if (session.subscription && typeof session.subscription === 'string') {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          const item = subscription.items.data[0];
          const currentPeriodStart = item?.current_period_start;
          const currentPeriodEnd = item?.current_period_end;

          await env.DB.prepare(
            `INSERT INTO subscriptions (id, user_id, stripe_subscription_id, stripe_customer_id, plan_id, status, current_period_start, current_period_end)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(stripe_subscription_id) DO UPDATE SET
               status = excluded.status,
               current_period_start = excluded.current_period_start,
               current_period_end = excluded.current_period_end,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
          )
            .bind(
              crypto.randomUUID(),
              userId,
              subscription.id,
              session.customer,
              planId,
              subscription.status,
              currentPeriodStart ? new Date(currentPeriodStart * 1000).toISOString() : null,
              currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
            )
            .run();
        }

        // Update transaction status
        if (session.payment_intent && typeof session.payment_intent === 'string') {
          await env.DB.prepare(
            `UPDATE transactions SET status = 'completed', stripe_payment_intent_id = ?
             WHERE stripe_session_id = ? AND status = 'pending'`,
          )
            .bind(session.payment_intent, session.id)
            .run();
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const item = subscription.items.data[0];
        const currentPeriodStart = item?.current_period_start;
        const currentPeriodEnd = item?.current_period_end;

        await env.DB.prepare(
          `UPDATE subscriptions SET
             status = ?,
             current_period_start = ?,
             current_period_end = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE stripe_subscription_id = ?`,
        )
          .bind(
            subscription.status,
            currentPeriodStart ? new Date(currentPeriodStart * 1000).toISOString() : null,
            currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
            subscription.id,
          )
          .run();
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;

        await env.DB.prepare(
          `UPDATE subscriptions SET
             status = 'canceled',
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE stripe_subscription_id = ?`,
        )
          .bind(subscription.id)
          .run();
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        const subscription = invoice.parent?.subscription_details?.subscription;

        if (subscription && typeof subscription === 'string') {
          const stripeSubscription = await stripe.subscriptions.retrieve(subscription);
          const item = stripeSubscription.items.data[0];
          const currentPeriodStart = item?.current_period_start;
          const currentPeriodEnd = item?.current_period_end;

          await env.DB.prepare(
            `UPDATE subscriptions SET
               status = ?,
               current_period_start = ?,
               current_period_end = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE stripe_subscription_id = ?`,
          )
            .bind(
              stripeSubscription.status,
              currentPeriodStart ? new Date(currentPeriodStart * 1000).toISOString() : null,
              currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
              subscription,
            )
            .run();
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subscription = invoice.parent?.subscription_details?.subscription;

        if (subscription && typeof subscription === 'string') {
          await env.DB.prepare(
            `UPDATE subscriptions SET
               status = 'past_due',
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE stripe_subscription_id = ?`,
          )
            .bind(subscription)
            .run();
        }
        break;
      }
    }
  } catch (err) {
    console.error(`Webhook event ${event.id} (${event.type}) processing failed:`, err);
  }
}

async function handleGetPlan(request: Request, env: Env): Promise<Response> {
  const userId = await getUserId(env, request);
  if (!userId) {
    return new Response(JSON.stringify({ plan: null }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sub = await env.DB.prepare(
    "SELECT plan_id, status, current_period_end FROM subscriptions WHERE user_id = ? AND status IN ('active', 'trialing') ORDER BY created_at DESC LIMIT 1",
  )
    .bind(userId)
    .first<{ plan_id: string; status: string; current_period_end: string }>();

  return new Response(
    JSON.stringify({
      plan: sub?.plan_id ?? null,
      status: sub?.status ?? null,
      expiresAt: sub?.current_period_end ?? null,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}
