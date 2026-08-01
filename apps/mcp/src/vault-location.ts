import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

type FinConfiguration = {
  vaultPath: string
}

export interface VaultLocationStore {
  get(): string | undefined
  save(vaultPath: string): void
}

export class FileVaultLocationStore implements VaultLocationStore {
  readonly #configurationPath: string
  #vaultPath: string | undefined

  constructor(configurationPath: string = defaultConfigurationPath()) {
    this.#configurationPath = configurationPath
    this.#vaultPath = readConfiguredVaultPath(configurationPath)
  }

  get(): string | undefined {
    return this.#vaultPath
  }

  save(vaultPath: string): void {
    const configurationDirectory = dirname(this.#configurationPath)
    const temporaryPath = `${this.#configurationPath}.${process.pid}.tmp`
    const configuration: FinConfiguration = { vaultPath }

    mkdirSync(configurationDirectory, { recursive: true })
    writeFileSync(temporaryPath, `${JSON.stringify(configuration, undefined, 2)}\n`, {
      mode: 0o600,
    })
    renameSync(temporaryPath, this.#configurationPath)
    this.#vaultPath = vaultPath
  }
}

export function defaultConfigurationPath(): string {
  const configuredPath = process.env.FIN_CONFIG_PATH

  if (configuredPath !== undefined && configuredPath.trim().length > 0) {
    return resolve(configuredPath)
  }

  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'fin', 'config.json')
  }

  if (process.platform === 'win32') {
    const applicationDataDirectory = process.env.APPDATA
    return join(
      applicationDataDirectory ?? join(homedir(), 'AppData', 'Roaming'),
      'fin',
      'config.json',
    )
  }

  const configurationDirectory = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(configurationDirectory, 'fin', 'config.json')
}

function readConfiguredVaultPath(configurationPath: string): string | undefined {
  if (!existsSync(configurationPath)) {
    return undefined
  }

  const configuration = JSON.parse(readFileSync(configurationPath, 'utf8')) as unknown

  if (
    typeof configuration !== 'object' ||
    configuration === null ||
    !('vaultPath' in configuration) ||
    typeof configuration.vaultPath !== 'string' ||
    configuration.vaultPath.trim().length === 0
  ) {
    throw new Error(`Invalid fin configuration at ${configurationPath}`)
  }

  return configuration.vaultPath
}
