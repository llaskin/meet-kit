import * as store from '../core/calendar-store.js'
import { topicsFromConfig } from '../../public/topics.js'

// What the /meet dropdown offers. Never errors to a visitor: any failure is
// "no topics", which simply hides the dropdown. A fail-safe empty result must
// not be cached -- it reflects a transient read failure, not the owner's
// actual configuration -- so only the successful path gets the 60s cache.
export async function onRequestGet({ env }) {
  try {
    const body = topicsFromConfig(await store.getConfig(env.DB))
    return Response.json(body, { headers: { 'Cache-Control': 'public, max-age=60' } })
  } catch {
    return Response.json({ topics: [], allowOther: false }, { headers: { 'Cache-Control': 'no-store' } })
  }
}
