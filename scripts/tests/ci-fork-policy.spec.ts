/** Fork scheduling preserves keyless validation without requiring upstream credentials or runners. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  name?: string
  if?: string
  run?: string
}

interface Workflow {
  jobs: Record<string, { if?: string; steps?: Step[] }>
}

const root = resolve(import.meta.dirname, '../..')
const fork = 'coldmountein/deepseek-harness-intel'

function workflow(file: string): Workflow {
  return load(readFileSync(resolve(root, '.github/workflows', file), 'utf8')) as Workflow
}

function enabled(condition: string, repository: string, event: string, variables: Record<string, string> = {}, untrusted = false, os = 'macOS'): boolean {
  return runInNewContext(condition, {
    inputs: { ci: true },
    runner: { os },
    vars: variables,
    github: {
      repository,
      event_name: event,
      ref: 'refs/heads/master',
      event: { pull_request: { head: { repo: { fork: untrusted } }, user: { login: 'contributor' } } },
    },
  }, { timeout: 1000 }) as boolean
}

describe('fork CI policy', () => {
  const runtime = workflow('build-exe-for-python-sdk.yml').jobs.build!
  const liveSteps = runtime.steps!.filter(step => /(?:Preflight installed-wheel real API|Run installed-wheel real API)/.test(step.name ?? ''))
  const e2e = workflow('e2e.yml').jobs.e2e!

  it('keeps all four live API preflight and test steps under the same opt-in policy', () => {
    expect(liveSteps).toHaveLength(4)
    for (const step of liveSteps) {
      expect(step.if).toContain("vars.DSH_ENABLE_REAL_API_TESTS == 'true'")
      expect(step.if).toContain('inputs.ci')
      expect(step.if).toContain('head.repo.fork')
      expect(step.if).toContain('dependabot[bot]')
    }
  })

  const liveConditions = liveSteps.map(step => ({ condition: step.if!, os: step.name?.endsWith('(Windows)') ? 'Windows' : 'macOS' }))
  for (const { condition, os } of [...liveConditions, { condition: e2e.if!, os: 'Linux' }]) {
    it.each(['push', 'schedule', 'workflow_dispatch', 'pull_request'])('leaves fork live tests disabled on %s until explicitly enabled', (event) => {
      expect(enabled(condition, fork, event, {}, false, os)).toBe(false)
      expect(enabled(condition, fork, event, { DSH_ENABLE_REAL_API_TESTS: 'false' }, false, os)).toBe(false)
      expect(enabled(condition, fork, event, { DSH_ENABLE_REAL_API_TESTS: 'true' }, false, os)).toBe(true)
    })

    it.each(['deepseek-ai/deepseek-harness', 'deepseek-harness/deepseek-harness'])('retains trusted live tests and untrusted-PR exclusion in %s', (repository) => {
      expect(enabled(condition, repository, 'push', {}, false, os)).toBe(true)
      expect(enabled(condition, repository, 'pull_request', {}, true, os)).toBe(false)
      expect(enabled(condition, fork, 'pull_request', { DSH_ENABLE_REAL_API_TESTS: 'true' }, true, os)).toBe(false)
    })
  }

  it('retains keyless tests and binary compatibility checks independently of live API opt-in', () => {
    for (const name of ['Run installed-wheel keyless black-box tests (POSIX)', 'Run installed-wheel keyless black-box tests (Windows)', 'Check Linux GLIBC requirements', 'Check macOS payload architecture and deployment target']) {
      const step = runtime.steps!.find(candidate => candidate.name === name)!
      expect(step).toBeDefined()
      expect(step.if).not.toMatch(/DSH_ENABLE_REAL_API_TESTS|secrets\./)
    }
    for (const step of liveSteps.filter(candidate => candidate.name?.startsWith('Preflight'))) {
      expect(step.run).toMatch(/exit 1|throw /)
    }
  })

  it.each(['serial-linux-selfhosted', 'serial-windows'])('requires fork opt-in for the %s runner pool', (name) => {
    const condition = workflow('ci-master.yml').jobs[name]!.if!
    expect(enabled(condition, fork, 'push')).toBe(false)
    expect(enabled(condition, fork, 'push', { DSH_ENABLE_SELF_HOSTED_CI: 'true' })).toBe(true)
    expect(enabled(condition, fork, 'workflow_dispatch', { DSH_ENABLE_SELF_HOSTED_CI: 'true' })).toBe(false)
    expect(enabled(condition, 'deepseek-ai/deepseek-harness', 'push')).toBe(true)
    expect(enabled(condition, 'deepseek-harness/deepseek-harness', 'push')).toBe(true)
  })
})
