import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import {createTwoFilesPatch} from 'diff';

// ==========================================
// Core Constants & Types
// ==========================================

const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";
const HASHLINE_DICT = Array.from({length: 256}, (_, i) => {
    const high = i >>> 4;
    const low = i & 0x0f;
    return `${NIBBLE_STR[high]}${NIBBLE_STR[low]}`;
});
const HASHLINE_REF_PATTERN = /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})$/;

interface ReplaceEdit {
    op: "replace";
    pos: string;
    end?: string;
    lines: string | string[];
}

interface AppendEdit {
    op: "append";
    pos?: string;
    lines: string | string[];
}

interface PrependEdit {
    op: "prepend";
    pos?: string;
    lines: string | string[];
}

type HashlineEdit = ReplaceEdit | AppendEdit | PrependEdit;

interface RawHashlineEdit {
    op?: "replace" | "append" | "prepend";
    pos?: string;
    end?: string;
    lines?: string | string[] | null;
}

export interface LineRef {
    line: number;
    hash: string;
}

// ==========================================
// Hash Computation (Node.js fallback)
// ==========================================

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

function computeNormalizedLineHash(lineNumber: number, normalizedContent: string): string {
    const stripped = normalizedContent;
    const seed = RE_SIGNIFICANT.test(stripped) ? 0 : lineNumber;
    // Replace Bun.hash.xxHash32 with a deterministic crypto hash mapping to 0-255
    const hashBuffer = crypto.createHash('md5').update(stripped + seed.toString()).digest();
    const index = hashBuffer.readUInt32LE(0) % 256;
    return HASHLINE_DICT[index];
}

function computeLineHash(lineNumber: number, content: string): string {
    return computeNormalizedLineHash(lineNumber, content.replace(/\r/g, "").trimEnd());
}

function computeLegacyLineHash(lineNumber: number, content: string): string {
    return computeNormalizedLineHash(lineNumber, content.replace(/\r/g, "").replace(/\s+/g, ""));
}

// ==========================================
// Diff Utils
// ==========================================

function generateUnifiedDiff(oldContent: string, newContent: string, filePath: string): string {
    return createTwoFilesPatch(filePath, filePath, oldContent, newContent, undefined, undefined, {context: 3});
}

function countLineDiffs(oldContent: string, newContent: string): { additions: number; deletions: number } {
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const oldSet = new Map<string, number>();
    for (const line of oldLines) {
        oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
    }
    const newSet = new Map<string, number>();
    for (const line of newLines) {
        newSet.set(line, (newSet.get(line) ?? 0) + 1);
    }
    let deletions = 0;
    for (const [line, count] of oldSet) {
        const newCount = newSet.get(line) ?? 0;
        if (count > newCount) deletions += count - newCount;
    }
    let additions = 0;
    for (const [line, count] of newSet) {
        const oldCount = oldSet.get(line) ?? 0;
        if (count > oldCount) additions += count - oldCount;
    }
    return {additions, deletions};
}

// ==========================================
// File Text Canonicalization
// ==========================================

interface FileTextEnvelope {
    content: string;
    hadBom: boolean;
    lineEnding: "\n" | "\r\n";
}

function detectLineEnding(content: string): "\n" | "\r\n" {
    const crlfIndex = content.indexOf("\r\n");
    const lfIndex = content.indexOf("\n");
    if (lfIndex === -1) return "\n";
    if (crlfIndex === -1) return "\n";
    return crlfIndex < lfIndex ? "\r\n" : "\n";
}

function stripBom(content: string): { content: string; hadBom: boolean } {
    if (!content.startsWith("\uFEFF")) return {content, hadBom: false};
    return {content: content.slice(1), hadBom: true};
}

function normalizeToLf(content: string): string {
    return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(content: string, lineEnding: "\n" | "\r\n"): string {
    if (lineEnding === "\n") return content;
    return content.replace(/\n/g, "\r\n");
}

function canonicalizeFileText(content: string): FileTextEnvelope {
    const stripped = stripBom(content);
    return {
        content: normalizeToLf(stripped.content),
        hadBom: stripped.hadBom,
        lineEnding: detectLineEnding(stripped.content),
    };
}

function restoreFileText(content: string, envelope: FileTextEnvelope): string {
    const withLineEnding = restoreLineEndings(content, envelope.lineEnding);
    if (!envelope.hadBom) return withLineEnding;
    return `\uFEFF${withLineEnding}`;
}

// ==========================================
// Validation & Error Handling
// ==========================================

interface HashMismatch {
    line: number;
    expected: string;
}

function isCompatibleLineHash(line: number, content: string, hash: string): boolean {
    return computeLineHash(line, content) === hash || computeLegacyLineHash(line, content) === hash;
}

function normalizeLineRef(ref: string): string {
    let trimmed = ref.trim();
    trimmed = trimmed.replace(/^(?:>>>|[+-])\s*/, "");
    trimmed = trimmed.replace(/\s*#\s*/, "#");
    trimmed = trimmed.replace(/\|.*$/, "");
    trimmed = trimmed.trim();
    if (HASHLINE_REF_PATTERN.test(trimmed)) return trimmed;
    const extracted = trimmed.match(/([0-9]+#[ZPMQVRWSNKTXJBYH]{2})/);
    if (extracted) return extracted[1];
    return ref.trim();
}

function parseLineRef(ref: string): LineRef {
    const normalized = normalizeLineRef(ref);
    const match = normalized.match(HASHLINE_REF_PATTERN);
    if (match) {
        return {line: Number.parseInt(match[1], 10), hash: match[2]};
    }
    const hashIdx = normalized.indexOf('#');
    if (hashIdx > 0) {
        const prefix = normalized.slice(0, hashIdx);
        const suffix = normalized.slice(hashIdx + 1);
        if (!/^\d+$/.test(prefix) && /^[ZPMQVRWSNKTXJBYH]{2}$/.test(suffix)) {
            throw new Error(`Invalid line reference: "${ref}". "${prefix}" is not a line number.`);
        }
    }
    throw new Error(`Invalid line reference format: "${ref}". Expected format: "{line_number}#{hash_id}"`);
}

class HashlineMismatchError extends Error {
    constructor(private readonly mismatches: HashMismatch[], private readonly fileLines: string[]) {
        super(HashlineMismatchError.formatMessage(mismatches, fileLines));
        this.name = "HashlineMismatchError";
    }

    static formatMessage(mismatches: HashMismatch[], fileLines: string[]): string {
        const mismatchByLine = new Map<number, HashMismatch>();
        for (const mismatch of mismatches) mismatchByLine.set(mismatch.line, mismatch);

        const displayLines = new Set<number>();
        for (const mismatch of mismatches) {
            const low = Math.max(1, mismatch.line - 2);
            const high = Math.min(fileLines.length, mismatch.line + 2);
            for (let line = low; line <= high; line++) displayLines.add(line);
        }

        const sortedLines = [...displayLines].sort((a, b) => a - b);
        const output: string[] = [];
        output.push(`${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. Use updated {line_number}#{hash_id} references below (>>> marks changed lines).`);
        output.push("");

        let previousLine = -1;
        for (const line of sortedLines) {
            if (previousLine !== -1 && line > previousLine + 1) output.push("    ...");
            previousLine = line;

            const content = fileLines[line - 1] ?? "";
            const hash = computeLineHash(line, content);
            const prefix = `${line}#${hash}|${content}`;
            if (mismatchByLine.has(line)) {
                output.push(`>>> ${prefix}`);
            } else {
                output.push(`    ${prefix}`);
            }
        }
        return output.join("\n");
    }
}

function suggestLineForHash(ref: string, lines: string[]): string | null {
    const hashMatch = ref.trim().match(/#([ZPMQVRWSNKTXJBYH]{2})$/);
    if (!hashMatch) return null;
    const hash = hashMatch[1];
    for (let i = 0; i < lines.length; i++) {
        if (isCompatibleLineHash(i + 1, lines[i], hash)) {
            return `Did you mean "${i + 1}#${computeLineHash(i + 1, lines[i])}"?`;
        }
    }
    return null;
}

function parseLineRefWithHint(ref: string, lines: string[]): LineRef {
    try {
        return parseLineRef(ref);
    } catch (parseError) {
        const hint = suggestLineForHash(ref, lines);
        if (hint && parseError instanceof Error) {
            throw new Error(`${parseError.message} ${hint}`);
        }
        throw parseError;
    }
}

function validateLineRefs(lines: string[], refs: string[]): void {
    const mismatches: HashMismatch[] = [];
    for (const ref of refs) {
        const {line, hash} = parseLineRefWithHint(ref, lines);
        if (line < 1 || line > lines.length) {
            throw new Error(`Line number ${line} out of bounds (file has ${lines.length} lines)`);
        }
        const content = lines[line - 1];
        if (!isCompatibleLineHash(line, content, hash)) {
            mismatches.push({line, expected: hash});
        }
    }
    if (mismatches.length > 0) {
        throw new HashlineMismatchError(mismatches, lines);
    }
}

// ==========================================
// Text Normalization & Autocorrect
// ==========================================

function normalizeTokens(text: string): string {
    return text.replace(/\s+/g, "");
}

function stripAllWhitespace(text: string): string {
    return normalizeTokens(text);
}

function stripTrailingContinuationTokens(text: string): string {
    return text.replace(/(?:&&|\|\||\?\?|\?|:|=|,|\+|-|\*|\/|\.|\()\s*$/u, "");
}

function stripMergeOperatorChars(text: string): string {
    return text.replace(/[|&?]/g, "");
}

function leadingWhitespace(text: string): string {
    const match = text.match(/^\s*/);
    return match ? match[0] : "";
}

const HASHLINE_PREFIX_RE = /^\s*(?:>>>|>>)?\s*\d+\s*#\s*[ZPMQVRWSNKTXJBYH]{2}\|/;
const DIFF_PLUS_RE = /^[+](?![+])/;

function stripLinePrefixes(lines: string[]): string[] {
    let hashPrefixCount = 0, diffPlusCount = 0, nonEmpty = 0;
    for (const line of lines) {
        if (line.length === 0) continue;
        nonEmpty += 1;
        if (HASHLINE_PREFIX_RE.test(line)) hashPrefixCount += 1;
        if (DIFF_PLUS_RE.test(line)) diffPlusCount += 1;
    }
    if (nonEmpty === 0) return lines;
    const stripHash = hashPrefixCount > 0 && hashPrefixCount >= nonEmpty * 0.5;
    const stripPlus = !stripHash && diffPlusCount > 0 && diffPlusCount >= nonEmpty * 0.5;
    if (!stripHash && !stripPlus) return lines;
    return lines.map((line) => {
        if (stripHash) return line.replace(HASHLINE_PREFIX_RE, "");
        if (stripPlus) return line.replace(DIFF_PLUS_RE, "");
        return line;
    });
}

function toNewLines(input: string | string[]): string[] {
    if (Array.isArray(input)) return stripLinePrefixes(input);
    return stripLinePrefixes(input.split("\n"));
}

function equalsIgnoringWhitespace(a: string, b: string): boolean {
    if (a === b) return true;
    return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

function stripInsertAnchorEcho(anchorLine: string, newLines: string[]): string[] {
    if (newLines.length === 0) return newLines;
    if (equalsIgnoringWhitespace(newLines[0], anchorLine)) return newLines.slice(1);
    return newLines;
}

function stripInsertBeforeEcho(anchorLine: string, newLines: string[]): string[] {
    if (newLines.length <= 1) return newLines;
    if (equalsIgnoringWhitespace(newLines[newLines.length - 1], anchorLine)) return newLines.slice(0, -1);
    return newLines;
}

function stripRangeBoundaryEcho(lines: string[], startLine: number, endLine: number, newLines: string[]): string[] {
    const replacedCount = endLine - startLine + 1;
    if (newLines.length <= 1 || newLines.length <= replacedCount) return newLines;
    let out = newLines;
    const beforeIdx = startLine - 2;
    if (beforeIdx >= 0 && equalsIgnoringWhitespace(out[0], lines[beforeIdx])) out = out.slice(1);
    const afterIdx = endLine;
    if (afterIdx < lines.length && out.length > 0 && equalsIgnoringWhitespace(out[out.length - 1], lines[afterIdx])) out = out.slice(0, -1);
    return out;
}

function restoreOldWrappedLines(originalLines: string[], replacementLines: string[]): string[] {
    if (originalLines.length === 0 || replacementLines.length < 2) return replacementLines;
    const canonicalToOriginal = new Map<string, { line: string; count: number }>();
    for (const line of originalLines) {
        const canonical = stripAllWhitespace(line);
        const existing = canonicalToOriginal.get(canonical);
        if (existing) existing.count += 1;
        else canonicalToOriginal.set(canonical, {line, count: 1});
    }
    const candidates: { start: number; len: number; replacement: string; canonical: string }[] = [];
    for (let start = 0; start < replacementLines.length; start += 1) {
        for (let len = 2; len <= 10 && start + len <= replacementLines.length; len += 1) {
            const span = replacementLines.slice(start, start + len);
            if (span.some((line) => line.trim().length === 0)) continue;
            const canonicalSpan = stripAllWhitespace(span.join(""));
            const original = canonicalToOriginal.get(canonicalSpan);
            if (original && original.count === 1 && canonicalSpan.length >= 6) {
                candidates.push({start, len, replacement: original.line, canonical: canonicalSpan});
            }
        }
    }
    if (candidates.length === 0) return replacementLines;
    const canonicalCounts = new Map<string, number>();
    for (const candidate of candidates) canonicalCounts.set(candidate.canonical, (canonicalCounts.get(candidate.canonical) ?? 0) + 1);
    const uniqueCandidates = candidates.filter((candidate) => (canonicalCounts.get(candidate.canonical) ?? 0) === 1);
    if (uniqueCandidates.length === 0) return replacementLines;
    uniqueCandidates.sort((a, b) => b.start - a.start);
    const correctedLines = [...replacementLines];
    for (const candidate of uniqueCandidates) correctedLines.splice(candidate.start, candidate.len, candidate.replacement);
    return correctedLines;
}

function maybeExpandSingleLineMerge(originalLines: string[], replacementLines: string[]): string[] {
    if (replacementLines.length !== 1 || originalLines.length <= 1) return replacementLines;
    const merged = replacementLines[0];
    const parts = originalLines.map((line) => line.trim()).filter((line) => line.length > 0);
    if (parts.length !== originalLines.length) return replacementLines;
    const indices: number[] = [];
    let offset = 0, orderedMatch = true;
    for (const part of parts) {
        let idx = merged.indexOf(part, offset);
        let matchedLen = part.length;
        if (idx === -1) {
            const stripped = stripTrailingContinuationTokens(part);
            if (stripped !== part) {
                idx = merged.indexOf(stripped, offset);
                if (idx !== -1) matchedLen = stripped.length;
            }
        }
        if (idx === -1) {
            const segment = merged.slice(offset);
            const segmentStripped = stripMergeOperatorChars(segment);
            const partStripped = stripMergeOperatorChars(part);
            const fuzzyIdx = segmentStripped.indexOf(partStripped);
            if (fuzzyIdx !== -1) {
                let strippedPos = 0, originalPos = 0;
                while (strippedPos < fuzzyIdx && originalPos < segment.length) {
                    if (!/[|&?]/.test(segment[originalPos])) strippedPos += 1;
                    originalPos += 1;
                }
                idx = offset + originalPos;
                matchedLen = part.length;
            }
        }
        if (idx === -1) {
            orderedMatch = false;
            break;
        }
        indices.push(idx);
        offset = idx + matchedLen;
    }
    const expanded: string[] = [];
    if (orderedMatch) {
        for (let i = 0; i < indices.length; i += 1) {
            const start = indices[i];
            const end = i + 1 < indices.length ? indices[i + 1] : merged.length;
            const candidate = merged.slice(start, end).trim();
            if (candidate.length === 0) {
                orderedMatch = false;
                break;
            }
            expanded.push(candidate);
        }
    }
    if (orderedMatch && expanded.length === originalLines.length) return expanded;
    const semicolonSplit = merged.split(/;\s+/).map((line, idx, arr) => (idx < arr.length - 1 && !line.endsWith(";") ? `${line};` : line)).map((line) => line.trim()).filter((line) => line.length > 0);
    if (semicolonSplit.length === originalLines.length) return semicolonSplit;
    return replacementLines;
}

function restoreIndentForPairedReplacement(originalLines: string[], replacementLines: string[]): string[] {
    if (originalLines.length !== replacementLines.length) return replacementLines;
    return replacementLines.map((line, idx) => {
        if (line.length === 0) return line;
        if (leadingWhitespace(line).length > 0) return line;
        const indent = leadingWhitespace(originalLines[idx]);
        if (indent.length === 0) return line;
        if (originalLines[idx].trim() === line.trim()) return line;
        return `${indent}${line}`;
    });
}

function autocorrectReplacementLines(originalLines: string[], replacementLines: string[]): string[] {
    let next = replacementLines;
    next = maybeExpandSingleLineMerge(originalLines, next);
    next = restoreOldWrappedLines(originalLines, next);
    next = restoreIndentForPairedReplacement(originalLines, next);
    return next;
}

// ==========================================
// Edit Operations & Primitives
// ==========================================

function applySetLine(lines: string[], pos: string, newLines: string | string[], options: {
    skipValidation?: boolean
} = {}): string[] {
    const idx = parseLineRef(pos).line - 1;
    const normalizedLines = toNewLines(newLines);
    const corrected = autocorrectReplacementLines([lines[idx]], normalizedLines);
    const out = [...lines];
    out.splice(idx, 1, ...corrected);
    return out;
}

function applyReplaceLines(lines: string[], pos: string, end: string, newLines: string | string[], options: {
    skipValidation?: boolean
} = {}): string[] {
    const startIdx = parseLineRef(pos).line - 1;
    const endIdx = parseLineRef(end).line - 1;
    const normalizedLines = toNewLines(newLines);
    const stripped = stripRangeBoundaryEcho(lines, startIdx + 1, endIdx + 1, normalizedLines);
    const originalLines = lines.slice(startIdx, endIdx + 1);
    const corrected = autocorrectReplacementLines(originalLines, stripped);
    const out = [...lines];
    out.splice(startIdx, endIdx - startIdx + 1, ...corrected);
    return out;
}

function applyInsertAfter(lines: string[], pos: string, newLines: string | string[], options: {
    skipValidation?: boolean
} = {}): string[] {
    const idx = parseLineRef(pos).line - 1;
    const normalizedLines = toNewLines(newLines);
    if (normalizedLines.length === 0) throw new Error("Insert payload must be non-empty");
    const stripped = stripInsertAnchorEcho(lines[idx], normalizedLines);
    if (stripped.length === 0) throw new Error("Insert payload must be non-empty");
    const out = [...lines];
    out.splice(idx + 1, 0, ...stripped);
    return out;
}

function applyInsertBefore(lines: string[], pos: string, newLines: string | string[], options: {
    skipValidation?: boolean
} = {}): string[] {
    const idx = parseLineRef(pos).line - 1;
    const normalizedLines = toNewLines(newLines);
    if (normalizedLines.length === 0) throw new Error("Insert payload must be non-empty");
    const stripped = stripInsertBeforeEcho(lines[idx], normalizedLines);
    if (stripped.length === 0) throw new Error("Insert payload must be non-empty");
    const out = [...lines];
    out.splice(idx, 0, ...stripped);
    return out;
}

function applyAppend(lines: string[], newLines: string | string[]): string[] {
    const normalizedLines = toNewLines(newLines);
    if (lines.length === 1 && lines[0] === "") return [...normalizedLines];
    return [...lines, ...normalizedLines];
}

function applyPrepend(lines: string[], newLines: string | string[]): string[] {
    const normalizedLines = toNewLines(newLines);
    if (lines.length === 1 && lines[0] === "") return [...normalizedLines];
    return [...normalizedLines, ...lines];
}

function arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function normalizeEditPayload(payload: string | string[]): string {
    return toNewLines(payload).join("\n");
}

function canonicalAnchor(anchor: string | undefined): string {
    if (!anchor) return "";
    return normalizeLineRef(anchor);
}

function buildDedupeKey(edit: HashlineEdit): string {
    switch (edit.op) {
        case "replace":
            return `replace|${canonicalAnchor(edit.pos)}|${edit.end ? canonicalAnchor(edit.end) : ""}|${normalizeEditPayload(edit.lines)}`;
        case "append":
            return `append|${canonicalAnchor(edit.pos)}|${normalizeEditPayload(edit.lines)}`;
        case "prepend":
            return `prepend|${canonicalAnchor(edit.pos)}|${normalizeEditPayload(edit.lines)}`;
        default:
            return JSON.stringify(edit);
    }
}

function dedupeEdits(edits: HashlineEdit[]): { edits: HashlineEdit[]; deduplicatedEdits: number } {
    const seen = new Set<string>();
    const deduped: HashlineEdit[] = [];
    let deduplicatedEdits = 0;
    for (const edit of edits) {
        const key = buildDedupeKey(edit);
        if (seen.has(key)) {
            deduplicatedEdits += 1;
            continue;
        }
        seen.add(key);
        deduped.push(edit);
    }
    return {edits: deduped, deduplicatedEdits};
}

function getEditLineNumber(edit: HashlineEdit): number {
    switch (edit.op) {
        case "replace":
            return parseLineRef(edit.end ?? edit.pos).line;
        case "append":
            return edit.pos ? parseLineRef(edit.pos).line : Number.NEGATIVE_INFINITY;
        case "prepend":
            return edit.pos ? parseLineRef(edit.pos).line : Number.NEGATIVE_INFINITY;
        default:
            return Number.POSITIVE_INFINITY;
    }
}

function collectLineRefs(edits: HashlineEdit[]): string[] {
    return edits.flatMap((edit) => {
        switch (edit.op) {
            case "replace":
                return edit.end ? [edit.pos, edit.end] : [edit.pos];
            case "append":
            case "prepend":
                return edit.pos ? [edit.pos] : [];
            default:
                return [];
        }
    });
}

function detectOverlappingRanges(edits: HashlineEdit[]): string | null {
    const ranges: { start: number; end: number; idx: number }[] = [];
    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        if (edit.op !== "replace" || !edit.end) continue;
        const start = parseLineRef(edit.pos).line;
        const end = parseLineRef(edit.end).line;
        ranges.push({start, end, idx: i});
    }
    if (ranges.length < 2) return null;
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < ranges.length; i++) {
        const prev = ranges[i - 1];
        const curr = ranges[i];
        if (curr.start <= prev.end) {
            return `Overlapping range edits detected: edit ${prev.idx + 1} (lines ${prev.start}-${prev.end}) overlaps with edit ${curr.idx + 1} (lines ${curr.start}-${curr.end}). Use pos-only replace for single-line edits.`;
        }
    }
    return null;
}

interface HashlineApplyReport {
    content: string;
    noopEdits: number;
    deduplicatedEdits: number;
}

function applyHashlineEditsWithReport(content: string, edits: HashlineEdit[]): HashlineApplyReport {
    if (edits.length === 0) return {content, noopEdits: 0, deduplicatedEdits: 0};
    const dedupeResult = dedupeEdits(edits);
    const EDIT_PRECEDENCE: Record<string, number> = {replace: 0, append: 1, prepend: 2};
    const sortedEdits = [...dedupeResult.edits].sort((a, b) => {
        const lineA = getEditLineNumber(a);
        const lineB = getEditLineNumber(b);
        if (lineB !== lineA) return lineB - lineA;
        return (EDIT_PRECEDENCE[a.op] ?? 3) - (EDIT_PRECEDENCE[b.op] ?? 3);
    });

    let noopEdits = 0;
    let lines = content.length === 0 ? [] : content.split("\n");
    const refs = collectLineRefs(sortedEdits);
    validateLineRefs(lines, refs);
    const overlapError = detectOverlappingRanges(sortedEdits);
    if (overlapError) throw new Error(overlapError);

    for (const edit of sortedEdits) {
        switch (edit.op) {
            case "replace": {
                const next = edit.end
                    ? applyReplaceLines(lines, edit.pos, edit.end, edit.lines, {skipValidation: true})
                    : applySetLine(lines, edit.pos, edit.lines, {skipValidation: true});
                if (arraysEqual(next, lines)) {
                    noopEdits += 1;
                    break;
                }
                lines = next;
                break;
            }
            case "append": {
                const next = edit.pos
                    ? applyInsertAfter(lines, edit.pos, edit.lines, {skipValidation: true})
                    : applyAppend(lines, edit.lines);
                if (arraysEqual(next, lines)) {
                    noopEdits += 1;
                    break;
                }
                lines = next;
                break;
            }
            case "prepend": {
                const next = edit.pos
                    ? applyInsertBefore(lines, edit.pos, edit.lines, {skipValidation: true})
                    : applyPrepend(lines, edit.lines);
                if (arraysEqual(next, lines)) {
                    noopEdits += 1;
                    break;
                }
                lines = next;
                break;
            }
        }
    }
    return {content: lines.join("\n"), noopEdits, deduplicatedEdits: dedupeResult.deduplicatedEdits};
}

// ==========================================
// Tool Definition & Executor Wrapper
// ==========================================

function normalizeAnchor(value: string | undefined): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
}

function requireLines(edit: RawHashlineEdit, index: number): string | string[] {
    if (edit.lines === undefined) throw new Error(`Edit ${index}: lines is required for ${edit.op ?? "unknown"}`);
    if (edit.lines === null) return [];
    return edit.lines;
}

function requireLine(anchor: string | undefined, index: number, op: "replace" | "append" | "prepend"): string {
    if (!anchor) throw new Error(`Edit ${index}: ${op} requires at least one anchor line reference (pos or end)`);
    return anchor;
}

function normalizeHashlineEdits(rawEdits: RawHashlineEdit[]): HashlineEdit[] {
    return rawEdits.map((rawEdit, index) => {
        const edit = rawEdit ?? {};
        switch (edit.op) {
            case "replace": {
                const pos = normalizeAnchor(edit.pos);
                const end = normalizeAnchor(edit.end);
                const anchor = requireLine(pos ?? end, index, "replace");
                const lines = requireLines(edit, index);
                const normalized: ReplaceEdit = {op: "replace", pos: anchor, lines};
                if (end) normalized.end = end;
                return normalized;
            }
            case "append": {
                const pos = normalizeAnchor(edit.pos);
                const end = normalizeAnchor(edit.end);
                const anchor = pos ?? end;
                const lines = requireLines(edit, index);
                const normalized: AppendEdit = {op: "append", lines};
                if (anchor) normalized.pos = anchor;
                return normalized;
            }
            case "prepend": {
                const pos = normalizeAnchor(edit.pos);
                const end = normalizeAnchor(edit.end);
                const anchor = pos ?? end;
                const lines = requireLines(edit, index);
                const normalized: PrependEdit = {op: "prepend", lines};
                if (anchor) normalized.pos = anchor;
                return normalized;
            }
            default:
                throw new Error(`Edit ${index}: unsupported op "${String(edit.op)}".`);
        }
    });
}

function canCreateFromMissingFile(edits: HashlineEdit[]): boolean {
    if (edits.length === 0) return false;
    return edits.every((edit) => (edit.op === "append" || edit.op === "prepend") && !edit.pos);
}

export const HASHLINE_EDIT_DESCRIPTION = `Edit files using LINE#ID format for precise, safe modifications.

WORKFLOW:
1. Read target file/range and copy exact LINE#ID tags.
2. Pick the smallest operation per logical mutation site.
3. Submit one edit call per file with all related operations.
4. If same file needs another call, re-read first.
5. Use anchors as "LINE#ID" only (never include trailing "|content").

<must>
- SNAPSHOT: All edits in one call reference the ORIGINAL file state. Do NOT adjust line numbers for prior edits in the same call - the system applies them bottom-up automatically.
- replace removes lines pos..end (inclusive) and inserts lines in their place. Lines BEFORE pos and AFTER end are UNTOUCHED - do NOT include them in lines. If you do, they will appear twice.
- lines must contain ONLY the content that belongs inside the consumed range. Content after end survives unchanged.
- Tags MUST be copied exactly from read output or >>> mismatch output. NEVER guess tags.
- Batch = multiple operations in edits[], NOT one big replace covering everything. Each operation targets the smallest possible change.
- lines must contain plain replacement text only (no LINE#ID prefixes, no diff + markers).
</must>

<operations>
LINE#ID FORMAT:
  Each line reference must be in "{line_number}#{hash_id}" format where:
  {line_number}: 1-based line number
  {hash_id}: Two CID letters from the set ZPMQVRWSNKTXJBYH

OPERATION CHOICE:
  replace with pos only -> replace one line at pos
  replace with pos+end -> replace range pos..end inclusive as a block (ranges MUST NOT overlap across edits)
  append with pos/end anchor -> insert after that anchor
  prepend with pos/end anchor -> insert before that anchor
  append/prepend without anchors -> EOF/BOF insertion (also creates missing files)

CONTENT FORMAT:
  lines can be a string (single line) or string[] (multi-line, preferred).
  If you pass a multi-line string, it is split by real newline characters.
  lines: null or lines: [] with replace -> delete those lines.

FILE MODES:
  delete=true deletes file and requires edits=[] with no rename
  rename moves final content to a new path and removes old path

RULES:
  1. Minimize scope: one logical mutation site per operation.
  2. Preserve formatting: keep indentation, punctuation, line breaks, trailing commas, brace style.
  3. Prefer insertion over neighbor rewrites: anchor to structural boundaries (}, ], },), not interior property lines.
  4. No no-ops: replacement content must differ from current content.
  5. Touch only requested code: avoid incidental edits.
  6. Use exact current tokens: NEVER rewrite approximately.
  7. For swaps/moves: prefer one range operation over multiple single-line operations.
  8. Anchor to structural lines (function/class/brace), NEVER blank lines.
  9. Re-read after each successful edit call before issuing another on the same file.
</operations>

<examples>
Given this file content after read:
  10#VK|function hello() {
  11#XJ|  console.log("hi");
  12#MB|  console.log("bye");
  13#QR|}
  14#TN|
  15#WS|function world() {

Single-line replace (change line 11):
  { op: "replace", pos: "11#XJ", lines: ["  console.log(\\"hello\\");"] }
  Result: line 11 replaced. Lines 10, 12-15 unchanged.

Range replace (rewrite function body, lines 11-12):
  { op: "replace", pos: "11#XJ", end: "12#MB", lines: ["  return \\"hello world\\";"] }
  Result: lines 11-12 removed, replaced by 1 new line. Lines 10, 13-15 unchanged.

Delete a line:
  { op: "replace", pos: "12#MB", lines: null }
  Result: line 12 removed. Lines 10-11, 13-15 unchanged.

Insert after line 13 (between functions):
  { op: "append", pos: "13#QR", lines: ["", "function added() {", "  return true;", "}"] }
  Result: 4 new lines inserted after line 13. All existing lines unchanged.

BAD - lines extend past end (DUPLICATES line 13):
  { op: "replace", pos: "11#XJ", end: "12#MB", lines: ["  return \\"hi\\";", "}"] }
  Line 13 is "}" which already exists after end. Including "}" in lines duplicates it.
  CORRECT: { op: "replace", pos: "11#XJ", end: "12#MB", lines: ["  return \\"hi\\";"] }
</examples>

<auto>
Built-in autocorrect (you do NOT need to handle these):
  Merged lines are auto-expanded back to original line count.
  Indentation is auto-restored from original lines.
  BOM and CRLF line endings are preserved automatically.
  Hashline prefixes and diff markers in text are auto-stripped.
  Boundary echo lines (duplicating adjacent surviving lines) are auto-stripped.
</auto>

RECOVERY (when >>> mismatch error appears):
  Copy the updated LINE#ID tags shown in the error output directly.
  Re-read only if the needed tags are missing from the error snippet.`;

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

export async function executeHashlineEditTool(args: {
    filePath: string,
    edits: RawHashlineEdit[],
    delete?: boolean,
    rename?: string
}): Promise<string> {
    try {
        const filePath = args.filePath;
        const deleteMode = args.delete;
        const rename = args.rename;

        if (deleteMode && rename) return "Error: delete and rename cannot be used together";
        if (deleteMode && args.edits.length > 0) return "Error: delete mode requires edits to be an empty array";
        if (!deleteMode && (!args.edits || !Array.isArray(args.edits) || args.edits.length === 0)) return "Error: edits parameter must be a non-empty array";

        const edits = deleteMode ? [] : normalizeHashlineEdits(args.edits);
        const exists = await fileExists(filePath);
        if (!exists && !deleteMode && !canCreateFromMissingFile(edits)) {
            return `Error: File not found: ${filePath}`;
        }

        if (deleteMode) {
            if (!exists) return `Error: File not found: ${filePath}`;
            await fs.unlink(filePath);
            return `Successfully deleted ${filePath}`;
        }

        const rawOldContent = exists ? await fs.readFile(filePath, "utf8") : "";
        const oldEnvelope = canonicalizeFileText(rawOldContent);

        const applyResult = applyHashlineEditsWithReport(oldEnvelope.content, edits);
        const canonicalNewContent = applyResult.content;

        if (canonicalNewContent === oldEnvelope.content && !rename) {
            let diagnostic = `No changes made to ${filePath}. The edits produced identical content.`;
            if (applyResult.noopEdits > 0) {
                diagnostic += ` No-op edits: ${applyResult.noopEdits}. Re-read the file and provide content that differs from current lines.`;
            }
            return `Error: ${diagnostic}`;
        }

        const writeContent = restoreFileText(canonicalNewContent, oldEnvelope);

        // Rename logic
        if (rename && rename !== filePath) {
            await fs.writeFile(rename, writeContent);
            if (exists) await fs.unlink(filePath);
            return `Moved ${filePath} to ${rename}`;
        } else {
            await fs.writeFile(filePath, writeContent);
            return `Updated ${filePath}`;
        }

    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof HashlineMismatchError) {
            return `Error: hash mismatch - ${message}\nTip: reuse LINE#ID entries from the latest read/edit output, or batch related edits in one call.`;
        }
        return `Error: ${message}`;
    }
}
