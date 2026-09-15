import { access } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return {
      shortCircuit: true,
      url: new URL('./electron-stub.mjs', import.meta.url).href,
    }
  }
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw error
    const parentPath = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : process.cwd()
    const basePath = resolvePath(parentPath, specifier)
    for (const candidate of [`${basePath}.ts`, `${basePath}.js`, `${basePath}/index.ts`, `${basePath}/index.js`]) {
      try {
        await access(candidate)
        return nextResolve(pathToFileURL(candidate).href, context)
      } catch {
        // Try the next conventional source extension.
      }
    }
    throw error
  }
}