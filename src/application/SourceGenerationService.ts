import { nanoid } from 'nanoid';
import type {
  ISourceGenerationService,
  IAgentService,
  IDatabaseService,
  IFileSystemService,
  IProviderRegistry,
  ISettingsService,
} from '@domain/interfaces';
import type {
  SourceGenerationEvent,
  SourceGenerationStep,
  StreamEvent,
  AgentName,
} from '@domain/types';
import { AGENT_REGISTRY } from '@domain/constants';
import { ContextBuilder } from './ContextBuilder';

type GenerationStep = {
  label: string;
  agentName: AgentName;
  prompt: string;
  /** Files the step must write or change. */
  outputs: string[];
};

/** A whole manuscript is read chapter by chapter, so the agent's default turn budget is far too small. */
export const SOURCE_GENERATION_MAX_TURNS = 80;

const LEDGER_PATH = 'source/motif-ledger.json';
const LEDGER_KEYS = ['systems', 'entries', 'structuralDevices', 'foreshadows', 'minorCharacters', 'flaggedPhrases', 'auditLog'] as const;

/** Returns an error message when the generated file is unusable, else null. */
function validateOutput(path: string, content: string): string | null {
  if (!content.trim()) return `${path} is empty.`;
  if (path !== LEDGER_PATH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return `${path} is not valid JSON.`;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return `${path} must be a JSON object.`;
  const missing = LEDGER_KEYS.filter((k) => !Array.isArray((parsed as Record<string, unknown>)[k]));
  if (missing.length > 0) return `${path} is missing array fields: ${missing.join(', ')}.`;
  return null;
}

/**
 * Repeated phrases in an imported book are the author's own voice, not
 * mistakes. Move any generated flagged phrases into an audit-log observation
 * so they can't act as bans.
 */
function demoteFlaggedPhrases(content: string): string {
  const ledger = JSON.parse(content) as Record<string, unknown[]>;
  const flagged = ledger.flaggedPhrases as Array<{ phrase?: unknown }>;
  if (flagged.length === 0) return content;
  const phrases = flagged.map((f) => (typeof f?.phrase === 'string' ? f.phrase : '')).filter(Boolean);
  ledger.flaggedPhrases = [];
  ledger.auditLog.push({
    id: nanoid(),
    chapterSlug: '',
    auditedAt: new Date().toISOString(),
    entriesAdded: 0,
    entriesUpdated: 0,
    notes: `Observed repeated phrases in the imported manuscript (observations only, not bans): ${phrases.join('; ')}`,
  });
  return JSON.stringify(ledger, null, 2);
}

const GENERATION_STEPS: GenerationStep[] = [
  {
    label: 'Generating pitch',
    agentName: 'Spark',
    prompt: 'This book was imported from an existing manuscript. Read every chapter in the chapters/ directory from beginning to end. Then produce a complete pitch card and write it to source/pitch.md. Include: title, genre, logline, themes, central conflict, protagonist, antagonist/antagonistic force, stakes, and hook.',
    outputs: ['source/pitch.md'],
  },
  {
    label: 'Generating outline & story bible',
    agentName: 'Verity',
    prompt: 'This book was imported from an existing manuscript. Read every chapter in the chapters/ directory from beginning to end. Then generate two source documents:\n\n1. **source/scene-outline.md** — A chapter-by-chapter structural plan. For each chapter: number, title, scene beats, POV character, timeline placement, and dramatic purpose.\n\n2. **source/story-bible.md** — Characters (name, role, arc, wants, needs, flaws, key relationships), world rules, locations (with descriptions), and a timeline of major events.\n\nBe thorough — these documents will guide the editorial pipeline.',
    outputs: ['source/scene-outline.md', 'source/story-bible.md'],
  },
  {
    label: 'Generating voice profile',
    agentName: 'Verity',
    prompt: 'This book was imported from an existing manuscript. Read every chapter in the chapters/ directory, paying close attention to prose style. Then generate source/voice-profile.md covering:\n\n- Sentence rhythm patterns (length variation, fragment use, compound structures)\n- Vocabulary tendencies (register, recurring words, domain-specific language)\n- POV approach (distance, interiority, tense)\n- Dialogue voice (attribution patterns, dialect handling, subtext style)\n- Tonal range (humor, gravity, lyricism, restraint)\n- Narrative habits (scene entry/exit patterns, transition style, exposition technique)\n- Distinctive signatures (any unique stylistic fingerprints)\n\nThis profile will be used to maintain voice consistency during revisions.',
    outputs: ['source/voice-profile.md'],
  },
  {
    label: 'Generating motif ledger',
    agentName: 'Verity',
    prompt: 'This book was imported from an existing manuscript. Read every chapter in the chapters/ directory. Then create source/motif-ledger.json with the following JSON structure:\n\n```json\n{\n  "systems": [...],\n  "entries": [...],\n  "structuralDevices": [...],\n  "foreshadows": [...],\n  "minorCharacters": [...],\n  "flaggedPhrases": [...],\n  "auditLog": [...]\n}\n```\n\nCatalog all recurring motifs and symbols (with character associations, first appearances, and occurrences by chapter). Document structural devices (framing, mirroring, callbacks). Track foreshadowing threads (planted vs paid-off vs abandoned). Note minor character motifs. Leave flaggedPhrases as an empty array: the author wrote this book, so repeated phrases are their voice, not errors. Mention notable repeated phrases only as observations in the notes of an auditLog entry. Each entry needs a unique nanoid-style ID string.\n\nBe comprehensive — this ledger drives the motif audit system.',
    outputs: [LEDGER_PATH],
  },
];

/**
 * SourceGenerationService — Orchestrates multi-agent source document generation
 * for imported manuscripts.
 *
 * Runs 4 sequential agent calls (Spark for pitch, Verity for outline/bible/voice/motif)
 * with per-step progress reporting. Individual step errors are caught and reported
 * without aborting the remaining steps.
 *
 * Follows the same pattern as RevisionQueueService: depends on injected interfaces
 * and uses IProviderRegistry.sendMessage() for each CLI call.
 */
export class SourceGenerationService implements ISourceGenerationService {
  constructor(
    private settings: ISettingsService,
    private agents: IAgentService,
    private db: IDatabaseService,
    private fs: IFileSystemService,
    private providers: IProviderRegistry,
  ) {}

  async generate(params: {
    bookSlug: string;
    onProgress: (event: SourceGenerationEvent) => void;
    onStreamEvent: (event: StreamEvent) => void;
    stepIndexes?: number[];
  }): Promise<void> {
    const { bookSlug, onProgress, onStreamEvent, stepIndexes } = params;

    // Build initial step list
    const wanted = stepIndexes ?? GENERATION_STEPS.map((_, i) => i);
    const steps: SourceGenerationStep[] = GENERATION_STEPS
      .map((s, i) => ({
        index: i,
        label: s.label,
        agentName: s.agentName,
        status: 'pending' as const,
      }))
      .filter((s) => wanted.includes(s.index));

    onProgress({ type: 'started', steps });

    const appSettings = await this.settings.load();
    const contextBuilder = new ContextBuilder();

    for (const i of steps.map((s) => s.index)) {
      const step = GENERATION_STEPS[i];

      onProgress({ type: 'step-started', index: i });

      try {
        // Snapshot the expected outputs so we can tell whether this step wrote them
        const before = new Map<string, string | null>();
        for (const path of step.outputs) {
          before.set(path, (await this.fs.fileExists(bookSlug, path)) ? await this.fs.readFile(bookSlug, path) : null);
        }

        // Load the agent
        const agent = await this.agents.load(step.agentName);

        // Create a conversation for this step
        const conversation = this.db.createConversation({
          id: nanoid(),
          bookSlug,
          agentName: step.agentName,
          pipelinePhase: null,
          purpose: 'pipeline',
          title: step.label,
        });

        // Save the user message
        this.db.saveMessage({
          conversationId: conversation.id,
          role: 'user',
          content: step.prompt,
          thinking: '',
        });

        // Build context (manifest + system prompt)
        const manifest = await this.fs.getProjectManifest(bookSlug);
        const messages = this.db.getMessages(conversation.id);
        const context = contextBuilder.build({
          agentName: step.agentName,
          agentSystemPrompt: agent.systemPrompt,
          manifest,
          messages,
          unattended: true,
        });

        // Accumulate the response
        let responseText = '';
        let thinkingText = '';
        const sessionId = nanoid();

        const agentMeta = AGENT_REGISTRY[step.agentName];

        await this.providers.sendMessage({
          model: appSettings.model,
          systemPrompt: context.systemPrompt,
          messages: context.conversationMessages,
          maxTokens: appSettings.maxTokens,
          thinkingBudget: appSettings.enableThinking
            ? (agentMeta?.thinkingBudget ?? 4000)
            : undefined,
          maxTurns: SOURCE_GENERATION_MAX_TURNS,
          bookSlug,
          sessionId,
          conversationId: conversation.id,
          onEvent: (event) => {
            if (event.type === 'textDelta') responseText += event.text;
            if (event.type === 'thinkingDelta') thinkingText += event.text;
            onStreamEvent(event);
          },
        });

        // Save the assistant response
        if (responseText.trim()) {
          this.db.saveMessage({
            conversationId: conversation.id,
            role: 'assistant',
            content: responseText,
            thinking: thinkingText,
          });
        }

        // A step is done only if its files were written or changed and are valid
        for (const path of step.outputs) {
          if (!(await this.fs.fileExists(bookSlug, path))) {
            throw new Error(`The agent finished without writing ${path}.`);
          }
          const content = await this.fs.readFile(bookSlug, path);
          if (content === before.get(path)) {
            throw new Error(`The agent finished without changing ${path}.`);
          }
          const invalid = validateOutput(path, content);
          if (invalid) throw new Error(invalid);
          if (path === LEDGER_PATH) {
            const cleaned = demoteFlaggedPhrases(content);
            if (cleaned !== content) await this.fs.writeFile(bookSlug, path, cleaned);
          }
        }

        onProgress({ type: 'step-done', index: i });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onProgress({ type: 'step-error', index: i, message });
        // Continue to next step — partial generation is better than nothing
      }
    }

    onProgress({ type: 'done' });
  }
}
