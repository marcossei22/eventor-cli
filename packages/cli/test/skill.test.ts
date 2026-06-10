import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from './harness.js';

// Skill/help não tocam a rede; respondemos com array vazio (não é usado).
const NO_NET = [{ status: 200, body: {} }];

describe('skill', () => {
  it('install grava o SKILL.md no --dir e reporta o caminho', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eventor-skill-'));
    const r = await runCli(['skill', 'install', '--dir', dir], NO_NET);

    expect(r.code).toBe(0);
    const target = JSON.parse(r.stdout).data.installed_to as string;
    expect(target).toBe(join(dir, 'eventor', 'SKILL.md'));
    expect(readFileSync(target, 'utf8')).toContain('Eventor — CLI headless');
  });

  it('show imprime o conteúdo do SKILL.md', async () => {
    const r = await runCli(['skill', 'show'], NO_NET);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('event setup');
    expect(r.stdout).toContain('Anti-patterns');
  });
});

describe('--help ensina', () => {
  it('o help raiz traz exemplos e a tabela de exit codes', async () => {
    const r = await runCli(['--help'], NO_NET);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Exit codes:');
    expect(r.stdout).toContain('event setup');
  });
});
