import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileVaultLocationStore } from './vault-location.js'

describe('FileVaultLocationStore', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('restores the selected Vault path in a later server process', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fin-vault-location-test-'))
    temporaryDirectories.push(directory)
    const configurationPath = join(directory, 'fin', 'config.json')
    const firstProcess = new FileVaultLocationStore(configurationPath)

    expect(firstProcess.get()).toBeUndefined()

    firstProcess.save('/vaults/personal')

    const laterProcess = new FileVaultLocationStore(configurationPath)
    expect(laterProcess.get()).toBe('/vaults/personal')
  })
})
