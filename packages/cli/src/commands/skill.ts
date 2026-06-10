import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';

import { CliContext, type CliDeps, type GlobalFlags } from '../context.js';
import { CliUsageError } from '../errors.js';
import { emit } from '../output.js';

/**
 * `eventor skill install` — instala o SKILL.md empacotado em ~/.claude/skills/eventor/,
 * ensinando o agente a usar o CLI. `eventor skill show` imprime o conteúdo.
 */
export function registerSkill(program: Command, deps: CliDeps): void {
  const skill = program.command('skill').description('Gerencia o SKILL.md (doc pro agente).');

  skill
    .command('install')
    .description('Instala o SKILL.md em ~/.claude/skills/eventor/SKILL.md (ou em --dir).')
    .option('--dir <path>', 'diretório de skills (default ~/.claude/skills)')
    .action((_opts, command: Command) => {
      const flags = command.optsWithGlobals() as GlobalFlags & { dir?: string };
      const ctx = new CliContext(flags, deps);

      const content = readFileSync(bundledSkillPath(), 'utf8');
      const baseDir = flags.dir?.trim() || join(homedir(), '.claude', 'skills');
      const target = join(baseDir, 'eventor', 'SKILL.md');

      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);

      emit(ctx.io, { data: { installed_to: target } });
      ctx.io.info(`✓ SKILL.md instalado em ${target}`);
    });

  skill
    .command('show')
    .description('Imprime o SKILL.md empacotado.')
    .action((_opts, command: Command) => {
      const flags = command.optsWithGlobals() as GlobalFlags;
      const ctx = new CliContext(flags, deps);
      ctx.io.out(readFileSync(bundledSkillPath(), 'utf8'));
    });
}

/** Resolve o SKILL.md empacotado, rodando do dist (build) ou do src (testes). */
function bundledSkillPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'SKILL.md'), // dist/index.js → packages/cli/SKILL.md
    join(here, '..', '..', 'SKILL.md'), // src/commands/skill.ts → packages/cli/SKILL.md
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new CliUsageError('SKILL.md empacotado não foi encontrado junto ao binário.');
}
