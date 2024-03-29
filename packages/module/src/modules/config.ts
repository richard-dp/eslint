import { addTemplate, tryResolveModule } from '@nuxt/kit'
import { stringifyImports } from 'unimport'
import type { Import } from 'unimport'
import type { Nuxt } from '@nuxt/schema'
import { relative, resolve } from 'pathe'
import { getPort } from 'get-port-please'
import type { ESLintConfigGenAddon } from '../types'
import type { NuxtESLintConfigOptions } from '@nuxt/eslint-config/flat'
import type { ConfigGenOptions, ModuleOptions } from '../module'
import { createAddonGlobals } from '../config-addons/globals'
import { isAbsolute } from 'path'

export async function setupConfigGen(options: ModuleOptions, nuxt: Nuxt) {
  const defaultAddons = [
    createAddonGlobals(nuxt),
  ]

  nuxt.hook('prepare:types', ({ declarations }) => {
    declarations.push('/// <reference path="./eslint-typegen.d.ts" />')
  })

  addTemplate({
    filename: 'eslint.config.mjs',
    write: true,
    async getContents() {
      const addons: ESLintConfigGenAddon[] = [
        ...defaultAddons,
      ]
      await nuxt.callHook('eslint:config:addons', addons)
      return generateESLintConfig(options, nuxt, addons)
    },
  })

  addTemplate({
    filename: 'eslint.config.d.mts',
    write: true,
    async getContents() {
      return [
        'import type { FlatConfigPipeline, FlatConfigItem } from "eslint-flat-config-utils"',
        'import { defineFlatConfigs } from "@nuxt/eslint-config/flat"',
        'declare const configs: FlatConfigPipeline<FlatConfigItem>',
        'declare const withNuxt: typeof defineFlatConfigs',
        'export default withNuxt',
        'export { withNuxt, defineFlatConfigs }',
      ].join('\n')
    },
  })

  setupDevToolsIntegration(nuxt)
}

async function generateESLintConfig(options: ModuleOptions, nuxt: Nuxt, addons: ESLintConfigGenAddon[]) {
  const importLines: Import[] = []
  const configItems: string[] = []

  const config: ConfigGenOptions = {
    standalone: true,
    ...typeof options.config !== 'boolean' ? options.config || {} : {},
  }

  importLines.push(
    {
      from: 'eslint-flat-config-utils',
      name: 'pipe',
    },
    {
      from: 'eslint-typegen',
      name: 'default',
      as: 'typegen',
    },
    {
      from: '@nuxt/eslint-config/flat',
      name: 'createConfigForNuxt',
    },
    {
      from: '@nuxt/eslint-config/flat',
      name: 'defineFlatConfigs',
    },
  )

  const basicOptions: NuxtESLintConfigOptions = {
    features: {
      stylistic: config.stylistic,
      standalone: config.standalone,
    },
    dirs: getDirs(nuxt),
  }

  configItems.push(`// Nuxt Configs\ncreateConfigForNuxt(${JSON.stringify(basicOptions, null, 2)})`)

  for (const addon of addons) {
    const resolved = await addon.getConfigs()
    if (resolved?.imports)
      importLines.push(...resolved.imports)
    if (resolved?.configs)
      configItems.push(...resolved.configs)
  }

  function absoluteImportPath(path: string) {
    return `file://${path}`;
  }

  async function resolveModule(id: string) {
    if (id) {
      if (id.includes('://'))
        return id;
      if (isAbsolute(id))
        return absoluteImportPath(id);
    }

    let resolvedModule = await tryResolveModule(id, import.meta.url) || id;
    if (isAbsolute(resolvedModule))
      resolvedModule = absoluteImportPath(resolvedModule);
    return resolvedModule
  }

  const imports = await Promise.all(importLines.map(async (line): Promise<Import> => {
    return {
      ...line,
      from: await resolveModule(line.from),
    }
  }))

  return [
    '// ESLint config generated by Nuxt',
    '/// <reference path="./eslint-typegen.d.ts" />',
    '',
    stringifyImports(imports, false),
    '',
    'export { defineFlatConfigs }',
    '',
    `export const configs = pipe()`,
    ``,
    `configs.append(`,
    configItems.join(',\n\n'),
    `)`,
    '',
    'export function withNuxt(...customs) {',
    '  return configs.append(...customs).onResolved(configs => typegen(configs, { dtsPath: new URL("./eslint-typegen.d.ts", import.meta.url) }))',
    '}',
    '',
    'export default withNuxt',
  ].join('\n')
}

function setupDevToolsIntegration(nuxt: Nuxt) {
  let viewerProcess: ReturnType<typeof import('@nuxt/devtools-kit')['startSubprocess']> | undefined
  let viewerPort: number | undefined
  let viewerUrl: string | undefined

  nuxt.hook('devtools:customTabs', (tabs) => {
    tabs.push({
      name: 'eslint-config',
      title: 'ESLint Config',
      icon: 'https://raw.githubusercontent.com/antfu/eslint-flat-config-viewer/main/public/favicon.svg',
      view: viewerUrl
        ? {
            type: 'iframe',
            src: viewerUrl,
          }
        : {
            type: 'launch',
            description: 'Start ESLint config viewer to inspect the local ESLint config',
            actions: [
              {
                label: 'Launch',
                pending: !!viewerProcess,
                handle: async () => {
                  const { startSubprocess } = await import('@nuxt/devtools-kit')
                  viewerPort = await getPort({
                    port: 8123,
                    portRange: [8123, 10000],
                  })
                  viewerProcess = startSubprocess(
                    {
                      command: 'npx',
                      args: ['eslint-flat-config-viewer'],
                      cwd: nuxt.options.rootDir,
                      env: {
                        PORT: viewerPort.toString(),
                        NO_OPEN: 'true',
                      },
                    },
                    {
                      id: 'eslint-flat-config-viewer',
                      name: 'ESLint Config Viewer',
                    },
                    nuxt,
                  )
                  nuxt.callHook('devtools:customTabs:refresh')

                  // Wait for viewer to be ready
                  const url = `http://localhost:${viewerPort}`
                  for (let i = 0; i < 100; i++) {
                    if (await fetch(url).then(r => r.ok).catch(() => false))
                      break
                    await new Promise(resolve => setTimeout(resolve, 500))
                  }
                  await new Promise(resolve => setTimeout(resolve, 2000))
                  viewerUrl = url
                },
              },
            ],
          },
    })
  })
}

function getDirs(nuxt: Nuxt): NuxtESLintConfigOptions['dirs'] {
  const dirs: Required<NuxtESLintConfigOptions['dirs']> = {
    pages: [],
    composables: [],
    components: [],
    layouts: [],
    plugins: [],
    middleware: [],
    modules: [],
    servers: [],
    root: [nuxt.options.rootDir],
    src: [nuxt.options.srcDir],
  }

  for (const layer of nuxt.options._layers) {
    const r = (t: string) => relative(nuxt.options.rootDir, resolve(layer.config.srcDir, t))

    dirs.src.push(r(''))
    dirs.pages.push(r(nuxt.options.dir.pages || 'pages'))
    dirs.layouts.push(r(nuxt.options.dir.layouts || 'layouts'))
    dirs.plugins.push(r(nuxt.options.dir.plugins || 'plugins'))
    dirs.middleware.push(r(nuxt.options.dir.middleware || 'middleware'))
    dirs.modules.push(r(nuxt.options.dir.modules || 'modules'))

    dirs.composables.push(r('composables'))
    dirs.composables.push(r('utils'))
    for (const dir of (layer.config.imports?.dirs ?? [])) {
      if (dir)
        dirs.composables.push(r(dir))
    }

    if (layer.config.components) {
      const options = layer.config.components || {}
      if (options !== true && 'dirs' in options) {
        for (const dir of options.dirs || []) {
          if (typeof dir === 'string')
            dirs.components.push(r(dir))
          else if (dir && 'path' in dir && typeof dir.path === 'string')
            dirs.components.push(r(dir.path))
        }
      }
    }
    else {
      dirs.components.push(r('components'))
    }
  }

  return dirs
}
