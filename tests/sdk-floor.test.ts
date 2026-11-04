import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MIN_SDK = [0, 0, 16]
const read = (p: string) => JSON.parse(readFileSync(resolve(__dirname, '..', p), 'utf8'))
const parse = (v: string) => v.replace(/^[\^~]/, '').split('.').map(Number)
const compare = (a: number[], b: number[]) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0 }

describe('Even Hub SDK floor', () => {
  const declared = parse(read('package.json').dependencies['@evenrealities/even_hub_sdk'])
  const installed = parse(read('node_modules/@evenrealities/even_hub_sdk/package.json').version)
  const manifest = parse(read('app.json').min_sdk_version)

  it('package.json pins the SDK at or above 0.0.16', () => { expect(compare(declared, MIN_SDK)).toBeGreaterThanOrEqual(0) })
  it('installed SDK matches the pin', () => { expect(installed).toEqual(declared) })
  it('app.json min_sdk_version matches the installed SDK', () => { expect(manifest).toEqual(installed) })
})
