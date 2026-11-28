import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CreativeAgentName } from '@domain/types';
import {
  toStoredBookPath,
  bookTitleFromPitch,
  describeBookTitleConflict,
  slugifyBookTitle,
  isVersionAtLeast,
  parseClaudeCliVersion,
  parseClaudeCliVersionError,
  formatModelLabel,
  getModelPricing,
  getPhaseStarterActions,
  isTextFilePath,
  AGENT_MULTI_CALL_STEPS,
  AGENT_QUICK_ACTIONS,
  AGENT_READ_GUIDANCE,
  AGENT_REGISTRY,
  AGENT_RESPONSE_BUFFER,
  BUILT_IN_PROVIDER_CONFIGS,
  CHARS_PER_TOKEN,
  CLAUDE_CLI_PRIMARY_MODEL,
  FABLE_MODEL_ID,
  LEGACY_CLAUDE_CLI_MODEL_IDS,
  CLAUDE_CLI_PROVIDER_ID,
  CLAUDE_CLI_SECONDARY_MODEL,
  CONTEXT_RESERVE_TOKENS,
  CREATIVE_AGENT_NAMES,
  DEFAULT_SETTINGS,
  FILE_MANIFEST_KEYS,
  HELPER_SLUG,
  LEGACY_PHASE_SLOTS,
  MAX_CONTEXT_TOKENS,
  MODEL_PRICING,
  PHASE_OUTPUT_CONTENT_MARKERS,
  PHASE_OUTPUT_FILES,
  PHASE_STARTER_ACTIONS,
  PHASE_TYPES,
  PASS_TEMPLATES,
  phaseTypeOutputs,
  PIPELINE_PHASES,
  PITCH_ROOM_SLUG,
  PROSE_FONTS,
  resolveProseFontStack,
  sanitizeFontFamilyName,
  TURN_BUDGET_THRESHOLDS,
  TURN_KEEP_COUNTS,
  VERITY_PHASE_FILES,
} from '@domain/constants';

const AGENT_NAMES = Object.keys(AGENT_REGISTRY);
const PHASE_IDS = PIPELINE_PHASES.map((p) => p.id);

describe('AGENT_REGISTRY', () => {
  it('every entry has non-empty required fields', () => {
    for (const meta of Object.values(AGENT_REGISTRY)) {
      expect(meta.filename).toMatch(/^[A-Z-]+\.md$/);
      expect(meta.role.length).toBeGreaterThan(0);
      expect(meta.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(meta.thinkingBudget).toBeGreaterThan(0);
      expect(meta.maxTurns).toBeGreaterThan(0);
    }
  });

  it('agent prompt filenames are unique', () => {
    const filenames = Object.values(AGENT_REGISTRY).map((m) => m.filename);
    expect(new Set(filenames).size).toBe(filenames.length);
  });
});

describe('CREATIVE_AGENT_NAMES', () => {
  it('is the registry minus Wrangler and Helper, without duplicates', () => {
    expect(new Set(CREATIVE_AGENT_NAMES).size).toBe(CREATIVE_AGENT_NAMES.length);
    const expected = AGENT_NAMES.filter((n) => n !== 'Wrangler' && n !== 'Helper');
    expect([...CREATIVE_AGENT_NAMES].sort()).toEqual(expected.sort());
  });

  it('keys AGENT_READ_GUIDANCE and AGENT_QUICK_ACTIONS exactly', () => {
    const creative = [...CREATIVE_AGENT_NAMES].sort();
    expect(Object.keys(AGENT_READ_GUIDANCE).sort()).toEqual(creative);
    expect(Object.keys(AGENT_QUICK_ACTIONS).sort()).toEqual(creative);
  });
});

describe('AGENT_READ_GUIDANCE', () => {
  it('alwaysRead, readIfRelevant, neverRead, and readAfter are pairwise disjoint per agent', () => {
    for (const [agent, guidance] of Object.entries(AGENT_READ_GUIDANCE)) {
      const { alwaysRead, readIfRelevant, neverRead, readAfter = [] } = guidance;
      const all = [...alwaysRead, ...readIfRelevant, ...neverRead, ...readAfter];
      expect(new Set(all).size, `overlapping read guidance for ${agent}`).toBe(all.length);
    }
  });

  it('Ghostlight reads the voice profile only after the read; planning docs and notes stay skipped (#25)', () => {
    const g = AGENT_READ_GUIDANCE.Ghostlight;
    expect(g.readAfter).toEqual(['source/voice-profile.md']);
    expect(g.neverRead).not.toContain('source/voice-profile.md');
    for (const path of ['source/pitch.md', 'source/scene-outline.md', 'source/story-bible.md', 'chapters/*/notes.md']) {
      expect(g.neverRead).toContain(path);
    }
  });
});

describe('AGENT_QUICK_ACTIONS', () => {
  it('every action has a non-empty label and prompt', () => {
    for (const actions of Object.values(AGENT_QUICK_ACTIONS)) {
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action.label.length).toBeGreaterThan(0);
        expect(action.prompt.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('run log plan (#87)', () => {
  it('the default plan has one run per legacy phase, in order, with the same agent and outputs', () => {
    expect(LEGACY_PHASE_SLOTS.map((s) => s.legacyPhase)).toEqual(PHASE_IDS);
    for (const slot of LEGACY_PHASE_SLOTS) {
      const phase = PIPELINE_PHASES.find((p) => p.id === slot.legacyPhase)!;
      expect(PHASE_TYPES[slot.type].agent, slot.legacyPhase).toBe(phase.agent);
      expect(PASS_TEMPLATES[slot.passKind].types, slot.legacyPhase).toContain(slot.type);
      const extractable = PHASE_OUTPUT_FILES[slot.legacyPhase];
      if (extractable) expect(PHASE_TYPES[slot.type].outputs, slot.legacyPhase).toEqual(extractable);
    }
    expect(LEGACY_PHASE_SLOTS.map((s) => s.type)).toEqual([
      'pitch', 'scaffold', 'draft', 'read', 'assessment',
      'revision-plan', 'revision', 'read', 'assessment',
      'copy-edit', 'fix-plan', 'mechanical-fixes', 'build', 'publish', 'query-agents',
    ]);
  });

  it('every phase type is keyed by its own name and expands {slug} in its outputs', () => {
    for (const [key, def] of Object.entries(PHASE_TYPES)) expect(def.type).toBe(key);
    expect(phaseTypeOutputs('build', 'my-book')).toEqual(['dist/my-book.md']);
    expect(phaseTypeOutputs('draft', 'my-book')).toEqual([]);
  });

  it('only action-gated types have no outputs', () => {
    for (const def of Object.values(PHASE_TYPES)) {
      expect(def.outputs.length === 0, def.type).toBe(def.gate === 'action');
    }
  });
});

describe('PHASE_STARTER_ACTIONS', () => {
  it('keys are real phase ids', () => {
    for (const id of Object.keys(PHASE_STARTER_ACTIONS)) expect(PHASE_IDS).toContain(id);
  });

  it('every label resolves in its phase agent quick actions', () => {
    for (const [id, labels] of Object.entries(PHASE_STARTER_ACTIONS)) {
      const phase = PIPELINE_PHASES.find((p) => p.id === id);
      const agent = phase?.agent;
      expect(agent, `phase ${id} needs an agent`).toBeTruthy();
      if (!agent || !(CREATIVE_AGENT_NAMES as string[]).includes(agent)) continue;
      const available = AGENT_QUICK_ACTIONS[agent as CreativeAgentName].map((a) => a.label);
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        expect(available, `"${label}" missing from ${agent} quick actions (phase ${id})`).toContain(label);
      }
    }
  });
});

describe('getPhaseStarterActions', () => {
  it('returns the curated actions in order with their prompts', () => {
    const actions = getPhaseStarterActions('scaffold', 'Verity');
    expect(actions.map((a) => a.label)).toEqual(['Build scene outline', 'Build story bible']);
    expect(actions[0].prompt).toBe(
      AGENT_QUICK_ACTIONS.Verity.find((a) => a.label === 'Build scene outline')?.prompt,
    );
  });

  it('falls back to the agent full list when the phase has no curated entry', () => {
    const original = PHASE_STARTER_ACTIONS.pitch;
    delete PHASE_STARTER_ACTIONS.pitch;
    try {
      expect(getPhaseStarterActions('pitch', 'Spark')).toEqual(AGENT_QUICK_ACTIONS.Spark);
    } finally {
      PHASE_STARTER_ACTIONS.pitch = original;
    }
  });

  it('returns nothing for agent-less phases and Wrangler', () => {
    expect(getPhaseStarterActions('build', null)).toEqual([]);
    expect(getPhaseStarterActions('pitch', 'Wrangler')).toEqual([]);
    expect(getPhaseStarterActions('pitch', 'Helper')).toEqual([]);
  });
});

describe('PIPELINE_PHASES', () => {
  it('phase ids are unique', () => {
    expect(new Set(PHASE_IDS).size).toBe(PHASE_IDS.length);
  });

  it('every phase agent is a registered agent (or null for system phases)', () => {
    for (const phase of PIPELINE_PHASES) {
      if (phase.agent !== null) {
        expect(AGENT_NAMES, `unknown agent in phase ${phase.id}`).toContain(phase.agent);
      }
      expect(phase.label.length).toBeGreaterThan(0);
      expect(phase.description.length).toBeGreaterThan(0);
    }
  });

  it('build is the only agent-less phase', () => {
    const agentless = PIPELINE_PHASES.filter((p) => p.agent === null).map((p) => p.id);
    expect(agentless).toEqual(['build']);
  });
});

describe('phase cross-references', () => {
  it('PHASE_OUTPUT_FILES keys are real phase ids with non-empty file lists', () => {
    for (const [id, files] of Object.entries(PHASE_OUTPUT_FILES)) {
      expect(PHASE_IDS).toContain(id);
      expect(files.length).toBeGreaterThan(0);
    }
  });

  it('PHASE_OUTPUT_CONTENT_MARKERS and VERITY_PHASE_FILES keys are real phase ids', () => {
    for (const id of Object.keys(PHASE_OUTPUT_CONTENT_MARKERS)) expect(PHASE_IDS).toContain(id);
    for (const id of Object.keys(VERITY_PHASE_FILES)) expect(PHASE_IDS).toContain(id);
  });

  it('query-agents marker accepts canonical section headings and rejects narration', () => {
    const marker = PHASE_OUTPUT_CONTENT_MARKERS['query-agents'];
    expect(marker).toBeDefined();
    if (!marker) return;
    expect(marker.test('## [Jane Doe Agency] — drafting')).toBe(true);
    expect(marker.test('## Jane Doe — drafting')).toBe(true);
    expect(marker.test('## Jane Doe - drafting')).toBe(true);
    expect(marker.test('I researched some agents for you today.')).toBe(false);
    expect(marker.test('## Heading without separator')).toBe(false);
  });
});

describe('BUILT_IN_PROVIDER_CONFIGS', () => {
  it('provider ids are unique and all configs are built-in', () => {
    const ids = BUILT_IN_PROVIDER_CONFIGS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const config of BUILT_IN_PROVIDER_CONFIGS) {
      expect(config.isBuiltIn).toBe(true);
      expect(config.name.length).toBeGreaterThan(0);
    }
  });

  it('the Claude CLI config is first — derived model constants depend on it', () => {
    expect(BUILT_IN_PROVIDER_CONFIGS[0].id).toBe(CLAUDE_CLI_PROVIDER_ID);
  });

  it('defaultModel, when set, exists in the provider model list', () => {
    for (const config of BUILT_IN_PROVIDER_CONFIGS) {
      if (config.defaultModel !== undefined) {
        expect(config.models.map((m) => m.id)).toContain(config.defaultModel);
      }
    }
  });

  it('every model belongs to its provider', () => {
    for (const config of BUILT_IN_PROVIDER_CONFIGS) {
      for (const model of config.models) {
        expect(model.providerId).toBe(config.id);
      }
    }
  });
});

describe('derived Claude CLI model constants', () => {
  it('primary is the Claude CLI default model', () => {
    expect(CLAUDE_CLI_PRIMARY_MODEL).toBe(BUILT_IN_PROVIDER_CONFIGS[0].defaultModel);
  });

  it('secondary is a different configured model', () => {
    const ids = BUILT_IN_PROVIDER_CONFIGS[0].models.map((m) => m.id);
    expect(ids).toContain(CLAUDE_CLI_SECONDARY_MODEL);
    expect(CLAUDE_CLI_SECONDARY_MODEL).not.toBe(CLAUDE_CLI_PRIMARY_MODEL);
  });

  it('every built-in Claude CLI model has a pricing entry', () => {
    for (const model of BUILT_IN_PROVIDER_CONFIGS[0].models) {
      const pricing = MODEL_PRICING[model.id];
      expect(pricing, `missing pricing for ${model.id}`).toBeDefined();
      expect(pricing.inputPer1M).toBeGreaterThan(0);
      expect(pricing.outputPer1M).toBeGreaterThan(0);
    }
  });

  it('ships CLI aliases, not dated model IDs, as the built-in Claude models', () => {
    const ids = BUILT_IN_PROVIDER_CONFIGS[0].models.map((m) => m.id);
    expect(ids).toEqual(['opus', 'sonnet', 'haiku']);
    expect(CLAUDE_CLI_PRIMARY_MODEL).toBe('opus');
    expect(CLAUDE_CLI_SECONDARY_MODEL).toBe('sonnet');
    for (const legacy of LEGACY_CLAUDE_CLI_MODEL_IDS) expect(ids).not.toContain(legacy);
  });

  it('never ships `best` (resolves to Fable) and probes Fable via its alias', () => {
    expect(BUILT_IN_PROVIDER_CONFIGS[0].models.map((m) => m.id)).not.toContain('best');
    expect(FABLE_MODEL_ID).toBe('fable');
    expect(MODEL_PRICING[FABLE_MODEL_ID]).toBeDefined();
  });

  it('keeps the default model first in MODEL_PRICING (estimateCost uses the first entry)', () => {
    expect(Object.keys(MODEL_PRICING)[0]).toBe(CLAUDE_CLI_PRIMARY_MODEL);
  });
});

describe('DEFAULT_SETTINGS', () => {
  it('references real models and an existing provider', () => {
    expect(DEFAULT_SETTINGS.model).toBe(CLAUDE_CLI_PRIMARY_MODEL);
    expect(DEFAULT_SETTINGS.secondaryModel).toBe(CLAUDE_CLI_SECONDARY_MODEL);
    expect(DEFAULT_SETTINGS.providers.map((p) => p.id)).toContain(DEFAULT_SETTINGS.activeProviderId);
  });

  it('starts uninitialized with detection flags off', () => {
    expect(DEFAULT_SETTINGS.initialized).toBe(false);
    expect(DEFAULT_SETTINGS.hasClaudeCli).toBe(false);
    expect(DEFAULT_SETTINGS.hasOllamaCli).toBe(false);
    expect(DEFAULT_SETTINGS.hasCodexCli).toBe(false);
  });
});

describe('context budget constants', () => {
  it('token constants are coherent', () => {
    expect(CHARS_PER_TOKEN).toBeGreaterThan(0);
    expect(CONTEXT_RESERVE_TOKENS).toBeGreaterThan(0);
    expect(CONTEXT_RESERVE_TOKENS).toBeLessThan(MAX_CONTEXT_TOKENS);
  });

  it('turn budget thresholds descend strictly within (0, 1)', () => {
    const { generous, moderate, tight } = TURN_BUDGET_THRESHOLDS;
    expect(generous).toBeLessThan(1);
    expect(generous).toBeGreaterThan(moderate);
    expect(moderate).toBeGreaterThan(tight);
    expect(tight).toBeGreaterThan(0);
  });

  it('turn keep counts descend with pressure', () => {
    const { moderate, tight, critical } = TURN_KEEP_COUNTS;
    expect(moderate).toBeGreaterThan(tight);
    expect(tight).toBeGreaterThan(critical);
    expect(critical).toBeGreaterThan(0);
  });

  it('every agent has a positive response buffer', () => {
    expect(Object.keys(AGENT_RESPONSE_BUFFER).sort()).toEqual([...AGENT_NAMES].sort());
    for (const buffer of Object.values(AGENT_RESPONSE_BUFFER)) {
      expect(buffer).toBeGreaterThan(0);
    }
  });
});

describe('FILE_MANIFEST_KEYS', () => {
  it('keys and paths are unique', () => {
    const keys = FILE_MANIFEST_KEYS.map((e) => e.key);
    const paths = FILE_MANIFEST_KEYS.map((e) => e.path);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('reserved slugs', () => {
  it('use the double-underscore reserved prefix and differ', () => {
    expect(PITCH_ROOM_SLUG.startsWith('__')).toBe(true);
    expect(HELPER_SLUG.startsWith('__')).toBe(true);
    expect(PITCH_ROOM_SLUG).not.toBe(HELPER_SLUG);
  });
});

describe('AGENT_MULTI_CALL_STEPS', () => {
  it('only creative agents have step schemas', () => {
    for (const agent of Object.keys(AGENT_MULTI_CALL_STEPS)) {
      expect(CREATIVE_AGENT_NAMES).toContain(agent);
    }
  });

  it('each schema has unique ids, positive maxTurns, and a target file per step', () => {
    for (const [agent, steps] of Object.entries(AGENT_MULTI_CALL_STEPS)) {
      const ids = steps.map((s) => s.id);
      expect(new Set(ids).size, `duplicate step ids for ${agent}`).toBe(ids.length);
      for (const step of steps) {
        expect(step.maxTurns).toBeGreaterThan(0);
        expect(step.promptTemplate.length).toBeGreaterThan(0);
        expect(
          step.scratchFile !== null || step.outputFile !== undefined,
          `step ${step.id} has no target file`
        ).toBe(true);
      }
    }
  });

  it('only read steps use the lightweight prompt — analysis and synthesis get the agent prompt (#23)', () => {
    for (const steps of Object.values(AGENT_MULTI_CALL_STEPS)) {
      for (const step of steps) {
        if (!step.lightweightPrompt) continue;
        expect(step.isSynthesis, `${step.id} is synthesis but lightweight`).toBe(false);
        expect(step.dynamic, `${step.id} is lightweight but not a chapter read step`).toBe(true);
      }
    }
  });

  it('each schema ends with exactly one synthesis step that writes a real output file', () => {
    for (const [agent, steps] of Object.entries(AGENT_MULTI_CALL_STEPS)) {
      const synthesis = steps.filter((s) => s.isSynthesis);
      expect(synthesis.length, `expected one synthesis step for ${agent}`).toBe(1);
      const last = steps[steps.length - 1];
      expect(last.isSynthesis, `last step of ${agent} must be synthesis`).toBe(true);
      expect(last.outputFile).toBeDefined();
    }
  });

  it('dynamic read steps carry the chapter list placeholder', () => {
    for (const steps of Object.values(AGENT_MULTI_CALL_STEPS)) {
      for (const step of steps.filter((s) => s.dynamic)) {
        expect(step.promptTemplate).toContain('{{CHAPTER_LIST}}');
      }
    }
  });
});

describe('Lumen lens coverage', () => {
  const lumenMd = readFileSync(resolve(__dirname, '../../agents/LUMEN.md'), 'utf8');
  const lenses = [...lumenMd.matchAll(/^### Lens (\d+): (.+)$/gm)].map((m) => `Lens ${m[1]}: ${m[2].trim()}`);
  const steps = AGENT_MULTI_CALL_STEPS.Lumen ?? [];
  const analysis = steps.filter((s) => !s.isSynthesis && !s.dynamic).map((s) => s.promptTemplate).join('\n');
  const synthesis = steps.find((s) => s.isSynthesis)!.promptTemplate;

  it('LUMEN.md defines lenses', () => {
    expect(lenses.length).toBeGreaterThan(0);
  });

  it('every LUMEN.md lens is analyzed by a pipeline step', () => {
    for (const lens of lenses) expect(analysis, lens).toContain(lens);
  });

  it('the synthesis step names every LUMEN.md lens and no others', () => {
    for (const lens of lenses) expect(synthesis, lens).toContain(lens);
    expect(synthesis).toContain(`All ${lenses.length} lens sections`);
    const used = new Set([...(analysis + synthesis).matchAll(/Lens \d+: [A-Z][A-Za-z &]+/g)].map((m) => m[0].trim()));
    for (const u of used) expect(lenses.some((l) => l.startsWith(u) || u.startsWith(l)), u).toBe(true);
  });
});

describe('getModelPricing', () => {
  it('returns the exact entry for listed aliases and full IDs', () => {
    expect(getModelPricing('sonnet')).toBe(MODEL_PRICING['sonnet']);
    expect(getModelPricing('claude-haiku-5-5')).toBe(MODEL_PRICING['claude-haiku-5-5']);
    expect(getModelPricing('claude-opus-4-20250514')).toBe(MODEL_PRICING['claude-opus-4-20250514']);
  });

  it('prices an unlisted full Claude ID by its family alias', () => {
    expect(getModelPricing('claude-sonnet-5-6')).toBe(MODEL_PRICING['sonnet']);
    expect(getModelPricing('claude-fable-6')).toBe(MODEL_PRICING['fable']);
  });

  it('falls back to the first entry for anything else', () => {
    expect(getModelPricing('llama3.2')).toBe(Object.values(MODEL_PRICING)[0]);
  });
});

describe('formatModelLabel', () => {
  it.each([
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-haiku-5-5', 'Haiku 5.5'],
    ['claude-opus-4-20250514', 'Opus 4'],
    ['claude-sonnet-4-5-20250929', 'Sonnet 4.5'],
  ])('%s → %s', (id, label) => {
    expect(formatModelLabel(id)).toBe(label);
  });

  it.each(['opus', 'llama3.2', 'gpt-4o', 'claude-3-5-sonnet-20241022'])('leaves %s unchanged', (id) => {
    expect(formatModelLabel(id)).toBe(id);
  });
});

describe('Claude CLI version helpers', () => {
  it('parseClaudeCliVersion reads `claude --version` output', () => {
    expect(parseClaudeCliVersion('2.1.318 (Claude Code)\n')).toBe('2.1.318');
    expect(parseClaudeCliVersion('')).toBeNull();
  });

  it('parseClaudeCliVersionError recognises the CLI-too-old API error inside NE\'s error label', () => {
    const message =
      "Claude CLI run failed: API Error: 400 Claude Code 2.1.220 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";
    expect(parseClaudeCliVersionError(message)).toEqual({ currentVersion: '2.1.220', requiredVersion: '2.1.280' });
  });

  it('parseClaudeCliVersionError tolerates a missing current version and ignores other errors', () => {
    expect(parseClaudeCliVersionError('does not support this model; version 3.0.0 or newer is required')).toEqual({
      currentVersion: null,
      requiredVersion: '3.0.0',
    });
    expect(parseClaudeCliVersionError('Claude CLI run failed (error_max_turns)')).toBeNull();
  });

  it.each([
    ['2.1.280', '2.1.280', true],
    ['2.1.318', '2.1.280', true],
    ['2.10.0', '2.9.9', true],
    ['2.1.220', '2.1.280', false],
    ['1.99.99', '2.0.0', false],
  ])('isVersionAtLeast(%s, %s) → %s', (v, min, expected) => {
    expect(isVersionAtLeast(v, min)).toBe(expected);
  });
});

describe('reading font helpers', () => {
  it('resolves presets to their stacks and unknown ids to the default', () => {
    expect(resolveProseFontStack('fraunces')).toBe(PROSE_FONTS[0].stack);
    expect(resolveProseFontStack('mono')).toContain('JetBrains Mono');
    expect(resolveProseFontStack(undefined)).toBe(PROSE_FONTS[0].stack);
    expect(resolveProseFontStack('bogus' as never)).toBe(PROSE_FONTS[0].stack);
  });

  it('quotes a custom name in front of the default stack', () => {
    expect(resolveProseFontStack('custom', 'EB Garamond')).toBe(`'EB Garamond', ${PROSE_FONTS[0].stack}`);
  });

  it('falls back to the default stack for an empty custom name', () => {
    expect(resolveProseFontStack('custom', '  ')).toBe(PROSE_FONTS[0].stack);
    expect(resolveProseFontStack('custom', "';{}")).toBe(PROSE_FONTS[0].stack);
  });

  it('strips CSS syntax from custom names and keeps letters in any script', () => {
    expect(sanitizeFontFamilyName("Foo'; color: red }")).toBe('Foo color red');
    expect(sanitizeFontFamilyName('  Noto   Serif  JP ')).toBe('Noto Serif JP');
    expect(sanitizeFontFamilyName('Ünïcode Sérif')).toBe('Ünïcode Sérif');
    expect(sanitizeFontFamilyName('x'.repeat(100))).toHaveLength(64);
  });

  it('defaults the reading font to Fraunces', () => {
    expect(DEFAULT_SETTINGS.proseFont).toBe('fraunces');
    expect(DEFAULT_SETTINGS.proseFontCustom).toBe('');
  });
});

describe('toStoredBookPath', () => {
  it('stores book paths with / separators', () => {
    expect(toStoredBookPath('chapters\\01-one\\draft.md')).toBe('chapters/01-one/draft.md');
    expect(toStoredBookPath('chapters/01-one/draft.md')).toBe('chapters/01-one/draft.md');
    expect(toStoredBookPath('about.json')).toBe('about.json');
  });
});

describe('book titles (#79)', () => {
  it('slugifyBookTitle folds case and punctuation into one folder name', () => {
    expect(slugifyBookTitle('The Hollow Crown')).toBe('the-hollow-crown');
    expect(slugifyBookTitle('  THE hollow-crown!! ')).toBe('the-hollow-crown');
    expect(slugifyBookTitle('Café Überall')).toBe('caf-berall');
    expect(slugifyBookTitle('!!!')).toBe('');
  });

  it('describeBookTitleConflict names the book, where it is, and the case/punctuation rule when needed', () => {
    const live = { slug: 'twin', title: 'Twin', archived: false };
    expect(describeBookTitleConflict('Twin', live)).toBe('A book titled "Twin" already exists. Choose another title.');
    expect(describeBookTitleConflict(' Twin ', live)).toBe('A book titled "Twin" already exists. Choose another title.');
    expect(describeBookTitleConflict('TWIN!', live)).toBe(
      'A book titled "Twin" already exists. Titles that differ only in case or punctuation count as the same. Choose another title.'
    );
    expect(describeBookTitleConflict('Ghost', { slug: 'ghost', title: 'Ghost', archived: true })).toBe(
      'An archived book titled "Ghost" already exists. Choose another title.'
    );
    expect(describeBookTitleConflict('Odd', { slug: 'odd', title: '', archived: false })).toBe(
      'A book in folder "odd" already exists. Titles that differ only in case or punctuation count as the same. Choose another title.'
    );
  });

  it('bookTitleFromPitch takes the first # heading, else "Untitled Book"', () => {
    expect(bookTitleFromPitch('intro\n# The Hollow Crown \n\n# Later')).toBe('The Hollow Crown');
    expect(bookTitleFromPitch('## Not a title\nprose')).toBe('Untitled Book');
    expect(bookTitleFromPitch('')).toBe('Untitled Book');
  });
});

describe('isTextFilePath', () => {
  it('accepts known text extensions in any case and any folder', () => {
    expect(isTextFilePath('chapters/01-opening/draft.md')).toBe(true);
    expect(isTextFilePath('about.json')).toBe(true);
    expect(isTextFilePath('source/NOTES.TXT')).toBe(true);
    expect(isTextFilePath('dist\\book.html')).toBe(true);
  });

  it('rejects images, models, exports and unknown types', () => {
    for (const p of ['assets/cover.png', 'assets/photo.JPG', 'assets/model.glb', 'dist/book.epub', 'dist/book.docx', 'dist/book.pdf']) {
      expect(isTextFilePath(p)).toBe(false);
    }
  });

  it('rejects names without an extension and bare dotfiles', () => {
    expect(isTextFilePath('LICENSE')).toBe(false);
    expect(isTextFilePath('.gitignore')).toBe(false);
    expect(isTextFilePath('.md')).toBe(false);
    expect(isTextFilePath('notes.md/cover')).toBe(false);
    expect(isTextFilePath('')).toBe(false);
  });
});
