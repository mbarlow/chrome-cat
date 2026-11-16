// Bounded reference context, shared by routing and retrieval. Prior answers
// help resolve pronouns; they are never treated as source evidence.
export function isFollowUp(question) {
  return /\b(it|its|they|their|them|that|those|these|this|you said|you mentioned|doesn't make sense|does not make sense|you're wrong|you are wrong|actually|instead)\b/i.test(question);
}

export function retrievalQuestion(question, turns = []) {
  const previous = turns.at(-1);
  return previous && isFollowUp(question)
    ? `${previous.question.slice(0, 500)} ${previous.answer.slice(0, 500)} ${question}` : question;
}

export function conversationContext(turns = []) {
  if (!turns.length) return '';
  return '[Recent conversation — reference context, not verified page evidence]\n' +
    turns.slice(-2).map(t => `User: ${t.question.slice(0, 500)}\nAssistant: ${t.answer.slice(0, 800)}`).join('\n') + '\n\n';
}
