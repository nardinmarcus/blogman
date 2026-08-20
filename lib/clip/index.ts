/**
 * B7-01 — Chrome 剪藏 (clip) entry public surface (issue #57).
 *
 * The ONLY producer of a `clip`-role reference source link. Agent/API
 * create-with-source stays `primary` in the B6 kernel; clipping is exposed
 * through the dedicated `/api/clip` Chrome route.
 */

export * from './types'
export * from './kernel'
