interface LoginProps {
  onSuccess: () => void
}

export function createLoginPage({ onSuccess }: LoginProps) {
  // Create main container
  const container = document.createElement('div')
  container.className = 'auth-page'

  // Create card
  const card = document.createElement('div')
  card.className = 'auth-card'

  // Logo
  const logo = document.createElement('div')
  logo.className = 'auth-logo'
  logo.textContent = 'Flaxia'

  // Heading
  const heading = document.createElement('h1')
  heading.className = 'auth-heading'
  heading.textContent = 'Sign in to Flaxia'

  // Form
  const form = document.createElement('form')
  form.className = 'auth-form'

  // Email input
  const emailGroup = document.createElement('div')
  emailGroup.className = 'form-group'
  
  const emailInput = document.createElement('input')
  emailInput.type = 'email'
  emailInput.placeholder = 'Email'
  emailInput.className = 'auth-input'
  emailInput.required = true

  // Password input
  const passwordGroup = document.createElement('div')
  passwordGroup.className = 'form-group'
  
  const passwordInput = document.createElement('input')
  passwordInput.type = 'password'
  passwordInput.placeholder = 'Password'
  passwordInput.className = 'auth-input'
  passwordInput.required = true

  // Error message
  const errorDiv = document.createElement('div')
  errorDiv.className = 'auth-error'
  errorDiv.style.display = 'none'

  // Submit button
  const submitButton = document.createElement('button')
  submitButton.type = 'submit'
  submitButton.className = 'auth-button'
  submitButton.textContent = 'Sign in'
  submitButton.disabled = true

  // Register link
  const registerLink = document.createElement('div')
  registerLink.className = 'auth-link'
  registerLink.innerHTML = 'Don\'t have an account? <a href="/register">Register</a>'

  // Validation
  const validateForm = () => {
    const emailValid = emailInput.value.trim() !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput.value)
    const passwordValid = passwordInput.value.trim() !== ''
    submitButton.disabled = !(emailValid && passwordValid)
  }

  emailInput.addEventListener('input', validateForm)
  passwordInput.addEventListener('input', validateForm)

  // Form submission
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    
    const email = emailInput.value.trim()
    const password = passwordInput.value.trim()

    if (!email || !password) {
      errorDiv.textContent = 'Please fill in all fields'
      errorDiv.style.display = 'block'
      return
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errorDiv.textContent = 'Invalid email format'
      errorDiv.style.display = 'block'
      return
    }

    submitButton.disabled = true
    submitButton.textContent = 'Signing in...'

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, password })
      })

      const data = await response.json() as { error?: string }

      if (response.ok) {
        onSuccess()
      } else {
        errorDiv.textContent = data.error || 'Invalid email or password'
        errorDiv.style.display = 'block'
      }
    } catch (error) {
      console.error('Login error:', error)
      errorDiv.textContent = 'Failed to connect. Please try again.'
      errorDiv.style.display = 'block'
    } finally {
      submitButton.disabled = false
      submitButton.textContent = 'Sign in'
    }
  })

  // Assemble form
  emailGroup.appendChild(emailInput)
  passwordGroup.appendChild(passwordInput)
  form.appendChild(emailGroup)
  form.appendChild(passwordGroup)
  form.appendChild(errorDiv)
  form.appendChild(submitButton)

  // Assemble card
  card.appendChild(logo)
  card.appendChild(heading)
  card.appendChild(form)
  card.appendChild(registerLink)

  // Assemble container
  container.appendChild(card)

  // Handle register link click
  const registerAnchor = registerLink.querySelector('a')
  if (registerAnchor) {
    registerAnchor.addEventListener('click', (e) => {
      e.preventDefault()
      window.history.pushState({}, '', '/register')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
  }

  return {
    getElement: () => container,
    destroy: () => {
      // Cleanup if needed
    }
  }
}
