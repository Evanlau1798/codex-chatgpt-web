import type { CodexToolResultMessage } from "../../types";
import type { ChatGptRetryPrompt } from "./steering";

const MAX_CORRECTION_RETRIES = 2;
const MAX_ERROR_EVIDENCE = 8;

const ENGLISH_CAUSAL_CLAIM = /(?:tool|command|execution|invocation|action|request|helper).{0,100}(?:blocked|rejected|denied|refused|prevented|stopped|did not execute).{0,100}(?:safety|security|policy|approval|permission|guardrail)|(?:safety|security|policy|approval|permission|guardrail).{0,100}(?:blocked|rejected|denied|refused|prevented|stopped).{0,100}(?:tool|command|execution|invocation|action|request|helper)/i;
const CHINESE_CAUSAL_CLAIM = /(?:工具|命令|執行|呼叫|操作|請求|helper).{0,60}(?:安全|資安|政策|規則|審核|批准|權限).{0,60}(?:擋下|攔下|阻擋|攔截|拒絕|阻止|禁止|未執行|沒有執行)|(?:安全|資安|政策|規則|審核|批准|權限).{0,60}(?:擋下|攔下|阻擋|攔截|拒絕|阻止|禁止).{0,60}(?:工具|命令|執行|呼叫|操作|請求|helper)/i;
const ENGLISH_NEGATED_ATTRIBUTION = /\b(?:cannot|can't|could not|couldn't|should not|shouldn't|must not|mustn't|do not|don't)\b.{0,100}\b(?:say|claim|infer|conclude|attribute|determine|name)\b/i;
const CHINESE_NEGATED_ATTRIBUTION = /(?:不能|無法|不應|不可|不該|不得).{0,50}(?:說|聲稱|宣稱|推斷|歸因|確認|命名)|(?:不能|無法).{0,20}判定.{0,10}是否/i;
const SAFETY_ERROR_EVIDENCE = /(?:safety|security|policy|approval|permission|guardrail|blocked|rejected|denied|refused)|(?:安全|資安|政策|規則|審核|批准|權限|擋下|攔下|阻擋|攔截|拒絕|禁止)/i;

const CORRECTION_PROMPT = [
  "Your previous response attributed a local tool action to a safety, security, policy, approval, or permission cause that is not supported by the returned Native tool evidence.",
  "No returned Native tool error supports that cause.",
  "Correct the response using only observable Native tool results from this turn.",
  "If an action produced no Native tool result, state only that it did not execute; do not infer or name an unreported cause.",
  "Continue the task and use the advertised tools if the action is still needed, then return a complete corrected answer.",
].join(" ");

function contentText(content: CodexToolResultMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
}

export function hasUnsupportedNativeToolCauseClaim(text: string): boolean {
  if (ENGLISH_NEGATED_ATTRIBUTION.test(text) || CHINESE_NEGATED_ATTRIBUTION.test(text)) return false;
  return ENGLISH_CAUSAL_CLAIM.test(text) || CHINESE_CAUSAL_CLAIM.test(text);
}

export class ChatGptToolEvidenceGuard {
  private readonly errorEvidence: string[] = [];
  private unsupportedCommentary = false;
  private correctionRetries = 0;

  observeToolResult(result: CodexToolResultMessage): void {
    if (!result.isError) return;
    this.errorEvidence.push(contentText(result.content));
    if (this.errorEvidence.length > MAX_ERROR_EVIDENCE) this.errorEvidence.shift();
    if (this.hasSupportingErrorEvidence()) this.unsupportedCommentary = false;
  }

  shouldEmitCommentary(text: string): boolean {
    if (!hasUnsupportedNativeToolCauseClaim(text) || this.hasSupportingErrorEvidence()) return true;
    this.unsupportedCommentary = true;
    return false;
  }

  retryPromptForAnswer(answer: string): ChatGptRetryPrompt | undefined {
    const unsupportedFinal = hasUnsupportedNativeToolCauseClaim(answer) && !this.hasSupportingErrorEvidence();
    if (!unsupportedFinal && !this.unsupportedCommentary) return undefined;
    if (this.correctionRetries >= MAX_CORRECTION_RETRIES) {
      throw new Error("ChatGPT Web repeatedly attributed an unexecuted Native tool action to an unsupported blocking cause");
    }
    this.correctionRetries += 1;
    this.unsupportedCommentary = false;
    return { text: CORRECTION_PROMPT, replaceCandidate: true };
  }

  private hasSupportingErrorEvidence(): boolean {
    return this.errorEvidence.some(text => SAFETY_ERROR_EVIDENCE.test(text));
  }
}
