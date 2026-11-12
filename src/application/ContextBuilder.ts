import type {
  AgentName,
  AssembledContext,
  ContextDiagnostics,
  CreativeAgentName,
  Message,
  MessageRole,
  ProjectManifest,
} from '@domain/types';
import {
  AGENT_READ_GUIDANCE,
  AGENT_RESPONSE_BUFFER,
  CREATIVE_AGENT_NAMES,
  MAX_CONTEXT_TOKENS,
  MAX_CALL_CONTEXT_TOKENS,
  CONTEXT_RESERVE_TOKENS,
  TURN_BUDGET_THRESHOLDS,
  TURN_KEEP_COUNTS,
} from '@domain/constants';
import { TokenEstimator } from './context/TokenEstimator';

/** Guidance name of the app-level author profile. */
const AUTHOR_PROFILE_FILE = 'author-profile.md';

/** Cap on the inlined author profile, so a runaway file can't crowd out the context. */
export const AUTHOR_PROFILE_MAX_WORDS = 4000;

/**
 * ContextBuilder — Builds a lean system prompt with a file manifest
 * and compacts conversation history using dynamic, token-budget-aware rules.
 *
 * The compactor calculates how much of the context window remains after the
 * system prompt, thinking budget, and response reserve are subtracted, then
 * uses that *remaining fraction* to decide how many conversation turns to keep.
 *
 * This means:
 * - Spark (tiny file context) → can keep 15+ turns
 * - Ghostlight full-read (120K manuscript) → keeps 2–3 turns
 * - The system automatically adapts as the book grows
 */
export class ContextBuilder {
  private tokenEstimator = new TokenEstimator();

  /**
   * Build the assembled context for an agent interaction.
   */
  build(params: {
    agentName: AgentName;
    agentSystemPrompt: string;
    manifest: ProjectManifest;
    messages: Message[];
    purposeInstructions?: string;
    thinkingBudget?: number;
    authorProfilePath?: string;
    /** Author profile text, read by the caller when
     *  `ContextBuilder.wantsAuthorProfile(agentName)` is true. Non-empty →
     *  inlined into the system prompt. Empty string → the profile doesn't
     *  exist, so it's dropped from the read guidance. Undefined → the
     *  guidance points at `authorProfilePath` as before. */
    authorProfileContent?: string;
    seriesBiblePath?: string;
    maxContextTokens?: number;
    authorEditsSection?: string;
  }): AssembledContext {
    const { agentName, agentSystemPrompt, manifest, messages, purposeInstructions, thinkingBudget, authorProfilePath, authorProfileContent, seriesBiblePath, maxContextTokens, authorEditsSection } = params;

    // 1. Build file manifest section
    const manifestSection = this.buildManifestSection(manifest);

    // 2. Build read guidance section (only for creative agents).
    // The author profile lives outside the book directory, where Bash can't
    // reach it. When the caller supplied its content, inline it and say so in
    // the guidance; when it's missing, leave it out of the guidance;
    // otherwise point at its absolute path.
    // Only agents whose guidance asks for the profile get it inlined.
    const profileText = ContextBuilder.wantsAuthorProfile(agentName) ? authorProfileContent?.trim() : undefined;
    const authorProfileSection = profileText ? this.buildAuthorProfileSection(profileText) : null;
    let guidanceSection = this.buildReadGuidance(agentName, (file) => {
      if (file !== AUTHOR_PROFILE_FILE || profileText === undefined) return `\`${file}\``;
      return profileText ? `the author profile (included below — don't read it)` : null;
    });
    if (guidanceSection && authorProfilePath && profileText === undefined) {
      guidanceSection = guidanceSection.replace(/`author-profile\.md`/g, `\`${authorProfilePath}\``);
    }

    // Replace placeholder 'series-bible.md' with absolute path so the agent can find it
    if (guidanceSection && seriesBiblePath) {
      guidanceSection = guidanceSection.replace(/`series-bible\.md`/g, `\`${seriesBiblePath}\``);
    }

    // 3. Build file-writing and tool-use instructions
    const writeInstructions = this.buildFileWriteInstructions();
    const toolUseInstructions = this.buildToolUseInstructions();

    // 4. Assemble full system prompt
    const sections = [agentSystemPrompt, '---', manifestSection];
    if (guidanceSection) sections.push(guidanceSection);
    if (authorProfileSection) sections.push(authorProfileSection);
    if (authorEditsSection) sections.push(authorEditsSection);
    sections.push(writeInstructions);
    sections.push(toolUseInstructions);
    if (seriesBiblePath) {
      sections.push(`### Series Context\nThis book is part of a series. The shared series bible is at: \`${seriesBiblePath}\`\nRead it for cross-volume character details, world rules, and timeline.`);
    }
    if (purposeInstructions) sections.push(purposeInstructions);

    const systemPrompt = sections.join('\n\n');

    // 5. Calculate the token budget available for conversation turns
    const systemPromptTokens = this.tokenEstimator.estimate(systemPrompt);
    const thinkingTokens = thinkingBudget ?? 0;
    const responseReserve = AGENT_RESPONSE_BUFFER[agentName] ?? CONTEXT_RESERVE_TOKENS;

    const effectiveMaxTokens = Math.min(maxContextTokens ?? MAX_CONTEXT_TOKENS, MAX_CALL_CONTEXT_TOKENS);
    const fixedOverhead = systemPromptTokens + thinkingTokens + responseReserve + CONTEXT_RESERVE_TOKENS;
    const turnBudgetTokens = Math.max(0, effectiveMaxTokens - fixedOverhead);

    // 6. Compact conversation history using dynamic budget
    const conversationMessages = this.compactConversation(messages, turnBudgetTokens);

    // 7. Build diagnostics
    const addedContent = [manifestSection, guidanceSection ?? '', authorProfileSection ?? '', writeInstructions, toolUseInstructions].join('\n');
    const manifestTokens = this.tokenEstimator.estimate(addedContent);

    const diagnostics: ContextDiagnostics = {
      filesAvailable: manifest.files.map((f) => f.path),
      conversationTurnsSent: conversationMessages.length,
      conversationTurnsDropped: messages.length - conversationMessages.length,
      manifestTokenEstimate: manifestTokens,
    };

    return { systemPrompt, conversationMessages, diagnostics };
  }

  /**
   * Build the file manifest section.
   * Lists all files with word counts so the agent knows what's available to Read.
   */
  private buildManifestSection(manifest: ProjectManifest): string {
    const lines: string[] = [];
    lines.push('## Active Book');
    lines.push('');
    lines.push(`- **Title**: ${manifest.meta.title}`);
    lines.push(`- **Author**: ${manifest.meta.author}`);
    lines.push(`- **Status**: ${manifest.meta.status}`);
    lines.push(`- **Chapters**: ${manifest.chapterCount}`);
    lines.push(`- **Total words**: ${manifest.totalWordCount.toLocaleString()}`);
    lines.push('');
    lines.push('## Project Files');
    lines.push('');
    lines.push('The following files exist in this book\'s directory. Use the **Read** tool to load any files you need for this task. Do not guess at file contents — read them.');
    lines.push('');

    if (manifest.files.length === 0) {
      lines.push('*No files yet — this is a new book.*');
    } else {
      lines.push('| File | Words |');
      lines.push('|------|-------|');
      for (const file of manifest.files) {
        lines.push(`| \`${file.path}\` | ${file.wordCount.toLocaleString()} |`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Build per-agent read guidance so the agent knows which files
   * are most relevant to its role.
   */
  private buildReadGuidance(
    agentName: AgentName,
    renderFile: (file: string) => string | null = (file) => `\`${file}\``,
  ): string | null {
    if (!CREATIVE_AGENT_NAMES.includes(agentName as CreativeAgentName)) return null;

    const raw = AGENT_READ_GUIDANCE[agentName as CreativeAgentName];
    if (!raw) return null;
    const render = (files: string[]) =>
      files.map(renderFile).filter((f): f is string => f !== null);
    const guidance = {
      alwaysRead: render(raw.alwaysRead),
      readIfRelevant: render(raw.readIfRelevant),
      readAfter: render(raw.readAfter ?? []),
      neverRead: render(raw.neverRead),
    };

    const lines: string[] = [];
    lines.push('## Context Loading Guidance');
    lines.push('');
    lines.push('Based on your role, here is guidance on which files to read:');
    lines.push('');

    if (guidance.alwaysRead.length > 0) {
      lines.push(`- **Always read**: ${guidance.alwaysRead.join(', ')}`);
    }
    if (guidance.readIfRelevant.length > 0) {
      lines.push(`- **Read if relevant to this task**: ${guidance.readIfRelevant.join(', ')}`);
    }
    if (guidance.readAfter.length > 0) {
      lines.push(`- **Read only after your main pass is done** (the author's stated intent, to check your findings against, not a guide to read by): ${guidance.readAfter.join(', ')}`);
    }
    if (guidance.neverRead.length > 0) {
      lines.push(`- **Skip** (not your domain): ${guidance.neverRead.join(', ')}`);
    }

    lines.push('');
    lines.push('Read the files you need before responding. Use the LS tool to explore chapter directories if needed.');

    return lines.join('\n');
  }

  /**
   * Whether this agent's read guidance asks for the author profile
   * (always or if relevant). Callers use this to decide whether to read the
   * profile and pass it as `authorProfileContent`.
   */
  static wantsAuthorProfile(agentName: AgentName): boolean {
    if (!CREATIVE_AGENT_NAMES.includes(agentName as CreativeAgentName)) return false;
    const guidance = AGENT_READ_GUIDANCE[agentName as CreativeAgentName];
    return guidance.alwaysRead.includes(AUTHOR_PROFILE_FILE) || guidance.readIfRelevant.includes(AUTHOR_PROFILE_FILE);
  }

  /** The author profile, inlined. Long profiles are cut at AUTHOR_PROFILE_MAX_WORDS. */
  private buildAuthorProfileSection(content: string): string {
    const words = content.split(/\s+/);
    const body = words.length > AUTHOR_PROFILE_MAX_WORDS
      ? `${words.slice(0, AUTHOR_PROFILE_MAX_WORDS).join(' ')}\n\n*[Author profile truncated at ${AUTHOR_PROFILE_MAX_WORDS} words.]*`
      : content;
    return `## Author Profile\n\n${body}`;
  }

  /**
   * Tool-use efficiency rules appended to every agent's system prompt.
   * Every turn re-sends the whole context, so fewer turns cost less.
   */
  private buildToolUseInstructions(): string {
    return `## Tool Use

Every turn re-sends the whole conversation, so work in as few turns as you can:
- Make independent tool calls together in one turn: read all the files you need at once, run several Greps at once.
- Read a file whole, once. Don't page through it in small chunks, and don't re-read a file that's already in this conversation. The Project Files table gives word counts.
- When you have several changes to make to one file (ledger entries, story-bible items, line fixes), decide all of them first, then make every Edit in a single turn.
- Don't write scripts to inspect or transform files. Use Read and Grep to inspect, Edit and Write to change.`;
  }

  /**
   * Standard file-writing instructions appended to every agent's system prompt.
   */
  private buildFileWriteInstructions(): string {
    return `## File Writing

You have direct access to read and write files in this book's directory. When the author approves your output, **write it to the appropriate file** — do not just display it in chat.

Key file paths:
- \`source/pitch.md\` — the approved pitch document
- \`source/voice-profile.md\` — the voice profile
- \`source/scene-outline.md\` — the scene-by-scene outline
- \`source/story-bible.md\` — characters, world, lore
- \`source/reader-report.md\` — Ghostlight's reader report
- \`source/dev-report.md\` — Lumen's development report
- \`source/audit-report.md\` — Sable's copy-edit audit
- \`source/project-tasks.md\` — Forge's revision task breakdown
- \`source/revision-prompts.md\` — Forge's per-chapter revision prompts
- \`source/style-sheet.md\` — Sable's style consistency rules
- \`source/metadata.md\` — Quill's publication metadata
- \`chapters/NN-slug/draft.md\` — chapter prose (Verity writes these)
- \`chapters/NN-slug/notes.md\` — chapter notes

**Rules:**
- Always ask for explicit approval before writing/overwriting a file
- For chapters, use the format \`chapters/NN-slug-name/draft.md\`
- Write complete files — never partial updates unless using the Edit tool for targeted fixes
`;
  }

  /**
   * Compact conversation history using dynamic token-budget-aware rules.
   *
   * Instead of fixed turn thresholds, this method:
   * 1. Calculates what fraction of the context window is available for turns
   * 2. Measures actual token sizes of messages (newest first)
   * 3. Keeps as many recent turns as the budget allows
   * 4. Prepends a context note when older turns are dropped
   *
   * @param messages - All messages in the conversation
   * @param turnBudgetTokens - How many tokens are available for conversation history
   */
  compactConversation(
    messages: Message[],
    turnBudgetTokens?: number,
  ): { role: MessageRole; content: string }[] {
    const totalTurns = messages.length;

    // No messages → nothing to compact
    if (totalTurns === 0) return [];

    // If no budget provided, fall back to generous fixed behavior
    if (turnBudgetTokens === undefined) {
      return this.compactByFixedRules(messages);
    }

    // Calculate budget fraction relative to the full context window
    const budgetFraction = turnBudgetTokens / MAX_CONTEXT_TOKENS;

    // Generous budget (> 40% free): try to keep everything, but still respect token limit
    if (budgetFraction > TURN_BUDGET_THRESHOLDS.generous) {
      return this.keepWithinBudget(messages, turnBudgetTokens, totalTurns);
    }

    // Moderate budget (20–40% free): cap at TURN_KEEP_COUNTS.moderate recent turns
    if (budgetFraction > TURN_BUDGET_THRESHOLDS.moderate) {
      const maxTurns = TURN_KEEP_COUNTS.moderate;
      return this.keepWithinBudget(messages, turnBudgetTokens, maxTurns);
    }

    // Tight budget (10–20% free): cap at TURN_KEEP_COUNTS.tight recent turns
    if (budgetFraction > TURN_BUDGET_THRESHOLDS.tight) {
      const maxTurns = TURN_KEEP_COUNTS.tight;
      return this.keepWithinBudget(messages, turnBudgetTokens, maxTurns);
    }

    // Critical budget (< 10% free): emergency mode
    const maxTurns = TURN_KEEP_COUNTS.critical;
    return this.keepWithinBudget(messages, turnBudgetTokens, maxTurns);
  }

  /**
   * Greedily keeps the most recent turns that fit within the token budget,
   * capped at maxTurns. Strips thinking content from older kept turns to
   * save tokens. Prepends a context note if any turns were dropped.
   */
  private keepWithinBudget(
    messages: Message[],
    budgetTokens: number,
    maxTurns: number,
  ): { role: MessageRole; content: string }[] {
    const totalTurns = messages.length;

    // Reserve ~200 tokens for the context note we might prepend
    const contextNoteReserve = 200;
    let remainingBudget = budgetTokens - contextNoteReserve;

    // Walk backwards from the most recent message, measuring token cost
    const keptMessages: { role: MessageRole; content: string }[] = [];
    let turnsConsidered = 0;

    for (let i = totalTurns - 1; i >= 0 && turnsConsidered < maxTurns; i--) {
      const msg = messages[i];
      const tokenCost = this.tokenEstimator.estimate(msg.content);

      if (tokenCost > remainingBudget) {
        // This message doesn't fit — stop here
        break;
      }

      remainingBudget -= tokenCost;
      keptMessages.unshift({ role: msg.role, content: msg.content });
      turnsConsidered++;
    }

    // If we couldn't keep even the most recent message, force-keep it
    // (the agent needs at least the current user message to respond)
    if (keptMessages.length === 0 && totalTurns > 0) {
      const lastMsg = messages[totalTurns - 1];
      keptMessages.push({ role: lastMsg.role, content: lastMsg.content });
    }

    // Prepend a context note if we dropped any turns
    const droppedCount = totalTurns - keptMessages.length;
    if (droppedCount > 0) {
      return [
        {
          role: 'user' as MessageRole,
          content: `[${droppedCount} earlier message${droppedCount === 1 ? '' : 's'} omitted to fit context budget. Continue from the recent messages below.]`,
        },
        {
          role: 'assistant' as MessageRole,
          content: 'Understood. Continuing from our recent conversation.',
        },
        ...keptMessages,
      ];
    }

    return keptMessages;
  }

  /**
   * Fallback compaction using fixed turn-count rules.
   * Used when no token budget is provided (e.g., during tests or
   * if the budget calculation is bypassed).
   */
  private compactByFixedRules(
    messages: Message[],
  ): { role: MessageRole; content: string }[] {
    const totalTurns = messages.length;

    // Short conversations: keep everything
    if (totalTurns <= 20) {
      return messages.map((m) => ({ role: m.role, content: m.content }));
    }

    // Medium conversations: keep last 8 turns with a note
    if (totalTurns <= 40) {
      const keepCount = 8;
      const droppedCount = totalTurns - keepCount;
      const recent = messages.slice(-keepCount);
      return [
        {
          role: 'user' as MessageRole,
          content: `[${droppedCount} earlier messages omitted for context efficiency. Read the conversation from this point.]`,
        },
        {
          role: 'assistant' as MessageRole,
          content: 'Understood. Continuing from our recent conversation.',
        },
        ...recent.map((m) => ({ role: m.role, content: m.content })),
      ];
    }

    // Long conversations: keep last 6 turns with a note
    const keepCount = 6;
    const droppedCount = totalTurns - keepCount;
    const recent = messages.slice(-keepCount);
    return [
      {
        role: 'user' as MessageRole,
        content: `[${droppedCount} earlier messages omitted for context efficiency. This is a long conversation — focus on the most recent context.]`,
      },
      {
        role: 'assistant' as MessageRole,
        content: 'Understood. Continuing with the recent context.',
      },
      ...recent.map((m) => ({ role: m.role, content: m.content })),
    ];
  }
}
