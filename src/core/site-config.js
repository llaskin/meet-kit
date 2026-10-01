// Display settings from meet.config.json, validated with safe fallbacks so a
// typo in the owner's JSON can never break booking.
const DEFAULTS = {
  displayName: '', pageTitle: 'Book a call',
  pageSubtitle: "Pick a time that works for you. You'll get a calendar invite with a video link.",
  eventTitle: 'Intro call', privacyUrl: '', termsUrl: '', accentColor: '#0b6cff',
}
const str = (v, d, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : d)
const url = (v) => (typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v.trim()) ? v.trim() : '')
const color = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : DEFAULTS.accentColor)

export function siteConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  return {
    displayName: str(raw.displayName, DEFAULTS.displayName, 80),
    pageTitle: str(raw.pageTitle, DEFAULTS.pageTitle, 80),
    pageSubtitle: str(raw.pageSubtitle, DEFAULTS.pageSubtitle, 200),
    eventTitle: str(raw.eventTitle, DEFAULTS.eventTitle, 120),
    privacyUrl: url(raw.privacyUrl),
    termsUrl: url(raw.termsUrl),
    accentColor: color(raw.accentColor),
  }
}
