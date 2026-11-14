/**
 * Subtle scroll-reveal & film-edge frame indicator choreography.
 * Respects `prefers-reduced-motion: reduce`.
 */
export function initScrollChoreography(): void {
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const revealItems = document.querySelectorAll<HTMLElement>('[data-reveal]')

  if (prefersReduced || typeof IntersectionObserver === 'undefined') {
    revealItems.forEach((el) => el.classList.add('is-visible'))
  } else {
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible')
            obs.unobserve(entry.target)
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
    )
    revealItems.forEach((el) => obs.observe(el))
  }

  // Update film-edge ruler active chapter & frame counter
  const sections: Array<{ id: string; frame: string; navHref: string }> = [
    { id: 'hero-stage', frame: '01A', navHref: '#hero-stage' },
    { id: 'cull-section', frame: '08C', navHref: '#cull-section' },
    { id: 'darkroom-section', frame: '14C', navHref: '#darkroom-section' },
    { id: 'agents-section', frame: '21A', navHref: '#agents-section' },
    { id: 'boundary-section', frame: '29D', navHref: '#boundary-section' },
    { id: 'engines-section', frame: '35A', navHref: '#engines-section' },
  ]

  const railCodeEl = document.getElementById('film-rail-frame')
  const railBarEl = document.getElementById('film-rail-fill')

  const onScroll = () => {
    const docH = Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
    const ratio = Math.max(0, Math.min(1, window.scrollY / docH))
    if (railBarEl) {
      railBarEl.style.transform = `scaleY(${ratio.toFixed(3)})`
    }

    const midY = window.innerHeight * 0.38
    let activeSec = sections[0]
    for (const sec of sections) {
      const el = document.getElementById(sec.id)
      if (!el) continue
      const rect = el.getBoundingClientRect()
      if (rect.top <= midY) {
        activeSec = sec
      }
    }

    if (railCodeEl) {
      railCodeEl.textContent = `EXP ${activeSec.frame}`
    }
    document.querySelectorAll<HTMLAnchorElement>('.optical-nav-links a').forEach((a) => {
      a.classList.toggle('is-current', a.getAttribute('href') === activeSec.navHref)
    })
  }

  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()
}
