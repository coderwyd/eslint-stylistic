/**
 * @fileoverview Scripts to update metadata and types.
 */

import { basename, dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import fg from 'fast-glob'
import { pascalCase } from 'change-case'
import type { JSONSchema4 } from 'json-schema'
import { compile as compileSchema } from 'json-schema-to-typescript'
import type { PackageInfo, RuleInfo } from '../packages/metadata/src/types'

const header = `
/* GENERATED, DO NOT EDIT DIRECTLY */
`.trimStart()

const cwd = process.cwd()

async function run() {
  const paths = (await fg('./packages/*/package.json', {
    onlyFiles: true,
    absolute: true,
    ignore: [
      'node_modules',
    ],
  })
  ).sort()

  const packages: PackageInfo[] = []
  for (const path of paths) {
    const pkg = await readPackage(dirname(path))
    await writeRulesIndex(pkg)
    await writeREADME(pkg)
    await generateDTS(pkg)
    await writePackageDTS(pkg)
    await updateExports(pkg)
    packages.push(pkg)
  }

  const packageJs = packages.find(i => i.shortId === 'js')!
  const packageTs = packages.find(i => i.shortId === 'ts')!
  const packageJsx = packages.find(i => i.shortId === 'jsx')!
  const packageGeneral = packages.find(i => i.name === '@stylistic/eslint-plugin')!

  // merge rules
  packageGeneral.rules = [...new Set([
    ...packageJs.rules.map(i => i.name),
    ...packageTs.rules.map(i => i.name),
    ...packageJsx.rules.map(i => i.name),
  ])]
    .map((name) => {
      const rule = packageJs.rules.find(i => i.name === name)! || packageTs.rules.find(i => i.name === name)! || packageJsx.rules.find(i => i.name === name)!
      return {
        ...rule,
        ruleId: `@stylistic/${name}`,
        originalId: undefined,
      }
    })
  packageGeneral.shortId = 'default'

  await fs.writeFile(
    join(cwd, 'packages', 'metadata', 'src', 'metadata.ts'),
`${header}
import type { PackageInfo, RuleInfo } from './types'

export const packages: Readonly<PackageInfo[]> = Object.freeze(${JSON.stringify(packages, null, 2)})

export const rules: Readonly<RuleInfo[]> = Object.freeze(packages.flatMap(p => p.rules))
`.trimStart(),
'utf-8',
  )
}

run()

async function readPackage(path: string): Promise<PackageInfo> {
  const dir = relative(join(cwd, 'packages'), path)
  const pkgId = `@stylistic/${dir.replace('eslint-plugin-', '')}`
  const shortId = pkgId.replace('@stylistic/', '')
  const pkgJSON = JSON.parse(await fs.readFile(join(path, 'package.json'), 'utf-8'))
  console.log(`Preparing ${path}`)
  const rulesDir = (await fg('rules/*', {
    cwd: path,
    onlyDirectories: true,
  })).sort()

  const rules = await Promise.all(
    rulesDir.map(async (ruleDir) => {
      const name = basename(ruleDir)
      let entry = join(path, ruleDir, `${name}.ts`).replace(/\\/g, '/')
      if (!existsSync(entry))
        entry = join(path, ruleDir, `${name}.js`).replace(/\\/g, '/')

      const url = pathToFileURL(entry).href
      const mod = await import(url)
      const meta = mod.default?.meta
      const rule: RuleInfo = {
        name,
        ruleId: `${pkgId}/${name}`,
        originalId: shortId === 'js'
          ? name
          : shortId === 'ts'
            ? `@typescript-eslint/${name}`
            : shortId === 'jsx'
              ? `react/${name}`
              : '',
        entry: relative(cwd, entry).replace(/\\/g, '/'),
        // TODO: check if entry exists
        docsEntry: relative(cwd, resolve(path, ruleDir, 'README.md')).replace(/\\/g, '/'),
        meta: {
          fixable: meta?.fixable,
          docs: {
            description: meta?.docs?.description,
            recommended: meta?.docs?.recommended,
          },
        },
      }
      return rule
    }),
  )

  return {
    name: pkgJSON.name,
    shortId,
    pkgId,
    path: relative(cwd, path),
    rules,
  }
}

async function writeRulesIndex(pkg: PackageInfo) {
  if (!pkg.rules.length)
    return

  const ruleDir = join(pkg.path, 'rules')

  await fs.mkdir(ruleDir, { recursive: true })

  const noCheck = (pkg.shortId === 'js' || pkg.shortId === 'jsx')

  const index = [
    header,
    noCheck ? '\n// TODO: remove this once every rule is migrated to TypeScript\n// eslint-disable-next-line ts/ban-ts-comment\n// @ts-nocheck\n' : '',
    'import type { Rules } from \'../dts\'',
    '',
    ...pkg.rules.map(i => `import ${camelCase(i.name)} from './${i.name}/${i.name}'`),
    '',
    'export default {',
    ...pkg.rules.map(i => `  '${i.name}': ${camelCase(i.name)},`),
    '} as unknown as Rules',
    '',
  ].join('\n')

  await fs.writeFile(join(ruleDir, `index.ts`), index, 'utf-8')
}

async function writePackageDTS(pkg: PackageInfo) {
  if (!pkg.rules.length)
    return

  const lines = [
    header,
    ...pkg.rules.map((rule) => {
      const name = basename(rule.name).replace(/\.\w+$/, '')
      return `import type { RuleOptions as ${pascalCase(name)}RuleOptions } from '../rules/${name}/types'`
    }),
    '',
    'export interface RuleOptions {',
    ...pkg.rules.flatMap((rule) => {
      const name = basename(rule.name).replace(/\.\w+$/, '')
      return [
        '  /**',
        `   * ${rule.meta?.docs?.description || ''}`,
        `   * @see https://eslint.style/rules/${pkg.shortId}/${rule.name}`,
        '   */',
        `  '${pkg.name.replace('eslint-plugin-', '')}/${rule.name}': ${pascalCase(name)}RuleOptions`,
      ]
    }),
    '}',
    '',
    'export interface UnprefixedRuleOptions {',
    ...pkg.rules.flatMap((rule) => {
      const name = basename(rule.name).replace(/\.\w+$/, '')
      return [
        '  /**',
        `   * ${rule.meta?.docs?.description || ''}`,
        `   * @see https://eslint.style/rules/${pkg.shortId}/${rule.name}`,
        '   */',
        `  '${rule.name}': ${pascalCase(name)}RuleOptions`,
      ]
    }),
    '}',
    '',
  ]

  await fs.writeFile(
    join(pkg.path, 'dts', 'rule-options.d.ts'),
    lines.join('\n'),
    'utf-8',
  )

  await fs.writeFile(
    join(pkg.path, 'dts', 'define-config-support.d.ts'),
`${header}
import type { RuleOptions } from './rule-options'

declare module 'eslint-define-config' {
  export interface CustomRuleOptions extends RuleOptions {}
}

export {}
`,
'utf-8',
  )
}

async function updateExports(pkg: PackageInfo) {
  if (!pkg.rules.length)
    return

  const pkgJson = JSON.parse(await fs.readFile(join(pkg.path, 'package.json'), 'utf-8'))
  pkgJson.exports = {
    '.': {
      types: './dts/index.d.ts',
      require: './dist/index.js',
      default: './dist/index.js',
    },
    './define-config-support': {
      types: './dts/define-config-support.d.ts',
    },
    './rule-options': {
      types: './dts/rule-options.d.ts',
    },
    ...Object.fromEntries(
      pkg.rules.map(i => [`./rules/${i.name}`, `./dist/${i.name}.js`]),
    ),
  }
  await fs.writeFile(join(pkg.path, 'package.json'), `${JSON.stringify(pkgJson, null, 2)}\n`, 'utf-8')
}

async function writeREADME(pkg: PackageInfo) {
  if (!pkg.rules.length)
    return

  const lines = [
    '<!--',
    header.trim(),
    '-->',
    '',
    `# ${pkg.name}`,
    '',
    '| Rule ID | Description | Fixable | Recommended |',
    '| --- | --- | --- | --- |',
    ...pkg.rules.map(i => `| [\`${i.ruleId}\`](./rules/${i.name}) | ${i.meta?.docs?.description || ''} | ${i.meta?.fixable ? '✅' : ''} | ${i.meta?.docs?.recommended ? '✅' : ''} |`),
  ]

  await fs.writeFile(join(pkg.path, 'rules.md'), lines.join('\n'), 'utf-8')
}

async function generateDTS(
  pkg: PackageInfo,
) {
  pkg.rules.map(async (rule) => {
    const module = await import(join(cwd, rule.entry))
    const meta = module.default.meta
    const messageIds = Object.keys(meta.messages ?? {})
    let schemas = meta.schema as JSONSchema4[] ?? []
    if (!Array.isArray(schemas))
      schemas = [schemas]

    const options = await Promise.all(schemas.map(async (schema, index) => {
      schema = JSON.parse(JSON.stringify(schema).replace(/\#\/items\/0\/\$defs\//g, '#/$defs/'))

      try {
        const compiled = await compileSchema(schema, `Schema${index}`, {
          bannerComment: '',
          style: {
            semi: false,
            singleQuote: true,
          },
        })
        return compiled
      }
      catch (error) {
        console.warn(`Failed to compile schema Schema${index} for rule ${rule.name}. Falling back to unknown.`)
        return `export type Schema${index} = unknown\n`
      }
    }))

    const optionTypes = options.map((_, index) => `Schema${index}?`)
    const ruleOptionTypeValue = Array.isArray(meta.schema)
      ? `[${optionTypes.join(', ')}]`
      : meta.schema
        ? 'Schema0'
        : '[]'

    const lines = [
      header,
      ...options,
      `export type RuleOptions = ${ruleOptionTypeValue}`,
      `export type MessageIds = ${messageIds.map(i => `'${i}'`).join(' | ') || 'never'}`,
      '',
    ]

    await fs.writeFile(resolve(cwd, rule.entry, '..', 'types.d.ts'), lines.join('\n'), 'utf-8')
  })
}

function camelCase(str: string) {
  return str
    .replace(/[^\d\w_-]+/, '')
    .replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}
