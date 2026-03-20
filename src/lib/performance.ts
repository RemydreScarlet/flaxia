// Performance utilities for optimizing CLS and LCP

export interface PerformanceMetrics {
  cls: number
  lcp: number
  fid: number
  ttfb: number
}

// Performance monitoring
export class PerformanceMonitor {
  private static instance: PerformanceMonitor
  private metrics: Partial<PerformanceMetrics> = {}
  private observers: PerformanceObserver[] = []

  static getInstance(): PerformanceMonitor {
    if (!PerformanceMonitor.instance) {
      PerformanceMonitor.instance = new PerformanceMonitor()
    }
    return PerformanceMonitor.instance
  }

  startMonitoring(): void {
    if (typeof window === 'undefined' || !window.PerformanceObserver) {
      return
    }

    try {
      // Monitor CLS
      const clsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const layoutShiftEntry = entry as any
          if (!layoutShiftEntry.hadRecentInput) {
            this.metrics.cls = (this.metrics.cls || 0) + layoutShiftEntry.value
          }
        }
      })
      clsObserver.observe({ entryTypes: ['layout-shift'] })
      this.observers.push(clsObserver)

      // Monitor LCP
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries()
        const lastEntry = entries[entries.length - 1]
        if (lastEntry) {
          this.metrics.lcp = lastEntry.startTime
        }
      })
      lcpObserver.observe({ entryTypes: ['largest-contentful-paint'] })
      this.observers.push(lcpObserver)

      // Monitor FID
      const fidObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.metrics.fid = (entry as any).processingStart - entry.startTime
        }
      })
      fidObserver.observe({ entryTypes: ['first-input'] })
      this.observers.push(fidObserver)

      // Monitor TTFB
      const navigationEntries = performance.getEntriesByType('navigation')
      if (navigationEntries.length > 0) {
        const navEntry = navigationEntries[0] as PerformanceNavigationTiming
        this.metrics.ttfb = navEntry.responseStart - navEntry.requestStart
      }
    } catch (error) {
      console.warn('Performance monitoring not fully supported:', error)
    }
  }

  getMetrics(): PerformanceMetrics {
    return {
      cls: this.metrics.cls || 0,
      lcp: this.metrics.lcp || 0,
      fid: this.metrics.fid || 0,
      ttfb: this.metrics.ttfb || 0
    }
  }

  stopMonitoring(): void {
    this.observers.forEach(observer => observer.disconnect())
    this.observers = []
  }
}

// Image optimization utilities
export const ImageOptimizer = {
  // Generate responsive image sizes
  getResponsiveSizes(width: number): string[] {
    const sizes = []
    const baseSizes = [320, 640, 960, 1280, 1920]
    
    for (const size of baseSizes) {
      if (size <= width) {
        sizes.push(`${size}w`)
      }
    }
    sizes.push(`${width}w`)
    return sizes
  },

  // Create aspect ratio style
  getAspectRatioStyle(width: number, height: number): string {
    const aspectRatio = (height / width) * 100
    return `padding-bottom: ${aspectRatio.toFixed(2)}%`
  },

  // Lazy load images with intersection observer
  lazyLoadImage(img: HTMLImageElement, src: string): void {
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            img.src = src
            img.classList.remove('lazy')
            observer.unobserve(img)
          }
        })
      }, {
        rootMargin: '50px'
      })
      
      img.classList.add('lazy')
      observer.observe(img)
    } else {
      // Fallback for browsers without IntersectionObserver
      img.src = src
    }
  }
}

// Layout stability utilities
export const LayoutStability = {
  // Reserve space for content
  reserveSpace(element: HTMLElement, width: number, height: number): void {
    element.style.minWidth = `${width}px`
    element.style.minHeight = `${height}px`
    element.style.contain = 'layout style paint'
  },

  // Prevent layout shifts during loading
  preventShift(container: HTMLElement): (() => void) | undefined {
    container.style.overflow = 'hidden'
    container.style.position = 'relative'
    
    // Add overlay to prevent interaction during loading
    const overlay = document.createElement('div')
    overlay.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: transparent;
      z-index: 1;
      pointer-events: none;
    `
    container.appendChild(overlay)
    
    // Remove overlay when content is loaded
    const removeOverlay = () => {
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay)
      }
      container.style.overflow = ''
    }
    
    // Auto-remove after a timeout
    setTimeout(removeOverlay, 5000)
    
    return removeOverlay
  }
}

// Performance optimization utilities
export const PerformanceOptimizer = {
  // Debounce function for performance
  debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number
  ): (...args: Parameters<T>) => void {
    let timeout: NodeJS.Timeout
    return (...args: Parameters<T>) => {
      clearTimeout(timeout)
      timeout = setTimeout(() => func(...args), wait)
    }
  },

  // Throttle function for performance
  throttle<T extends (...args: any[]) => any>(
    func: T,
    limit: number
  ): (...args: Parameters<T>) => void {
    let inThrottle: boolean
    return (...args: Parameters<T>) => {
      if (!inThrottle) {
        func(...args)
        inThrottle = true
        setTimeout(() => inThrottle = false, limit)
      }
    }
  },

  // Use requestIdleCallback for non-critical tasks
  runWhenIdle(callback: () => void, timeout = 2000): void {
    if ('requestIdleCallback' in window) {
      (window as any).requestIdleCallback(callback, { timeout })
    } else {
      setTimeout(callback, 1)
    }
  }
}

// Initialize performance monitoring
export const initPerformanceMonitoring = (): void => {
  const monitor = PerformanceMonitor.getInstance()
  monitor.startMonitoring()
  
  // Log metrics after page load
  if (document.readyState === 'complete') {
    setTimeout(() => {
      const metrics = monitor.getMetrics()
      console.log('Core Web Vitals:', metrics)
      
      // Report to analytics if available
      if (typeof window !== 'undefined' && (window as any).gtag) {
        (window as any).gtag('event', 'core_web_vitals', {
          cls: metrics.cls,
          lcp: metrics.lcp,
          fid: metrics.fid,
          ttfb: metrics.ttfb
        })
      }
    }, 3000)
  } else {
    window.addEventListener('load', () => {
      setTimeout(() => {
        const metrics = monitor.getMetrics()
        console.log('Core Web Vitals:', metrics)
      }, 3000)
    })
  }
}
