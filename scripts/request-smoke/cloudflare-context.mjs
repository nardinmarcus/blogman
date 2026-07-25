export async function getCloudflareContext() {
  const context = globalThis.__BLOGMAN_RESTORED_D1_WORKER_CONTEXT__
  if (!context) throw new Error('Restored D1 smoke context is unavailable')
  return context
}
