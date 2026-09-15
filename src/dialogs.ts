/**
 * 对话框（票 #10 第一条验收）：**策略是数据，答复是判断，记录是结果**。
 *
 * 这一层不 import electron 也不 import playwright：它只回答"这个对话框该怎么答、
 * 答完记下什么、给别人看的时候怎么说"，所以它能在毫秒级被单独读回，而真外壳那一侧
 * 只负责把答复交给引擎。
 *
 * ## 为什么默认是"立刻答复"，而不是"等着 Agent 来答复"
 *
 * 实测（`docs/research/dialogs-upload-download-iframes.md`）：
 *
 *  - Playwright 只在处理器**返回 promise** 时才认为这个对话框"有人负责"
 *    （`coreBundle.js` 的 `dialogDidOpen`：处理器返回真值才算 `hasHandlers`，否则
 *    自己把它 close 掉）。所以"注册了处理器却不回答"这件事只在 **async 处理器**上
 *    成立 —— 而一旦悬着，页面就真的被挡住：弹窗期间连一个新 `page.evaluate` 都落不
 *    下去，释放之后才恢复。
 *  - 于是"把对话框留给 Agent 稍后答复"是不可能的：**能答复它的那个人（模型）此刻正
 *    卡在那个动作里**。策略必须是数据：Agent 提前说"下一次 confirm 我要接受"，
 *    弹出时我们立刻照办，页面从头到尾不阻塞。
 *
 * ## 为什么 `beforeunload` 恒为 dismiss
 *
 * 实测两条（探针五 R1/R2/R3）：接受它**既不会让导航通过**（`goto` 一律
 * `net::ERR_ABORTED`，页面留在原地），**又会让触发它的那次点击挂满超时**；
 * 而 dismiss 会让 Playwright 立刻判定"这次导航被 beforeunload 取消"，点击 53ms 就
 * 返回。所以对 beforeunload，"拒绝"是既不丢数据、又不卡住 Agent 的那条路，
 * 而这个对话框的文本（type + 空 message）照样被记下来，让动作结果能说出原因。
 */

/** 一次对话框在策略眼里是哪一种。`beforeunload` 走的是同一个 `dialog` 事件。 */
export type DialogKind = string

/** 一条答复。 */
export interface DialogAnswer {
  /** `true` = 接受（确定 / 离开这一页），`false` = 拒绝（取消 / 留下）。 */
  accept: boolean
  /** 只有 `prompt` 用得上：接受时替页面填进去的文本。 */
  promptText?: string
}

/**
 * Agent 提前声明的对话框策略。
 *
 * 它只覆盖 `alert` / `confirm` / `prompt` 三种：`beforeunload` 有它自己的固定规则
 * （见文件头），不受这里影响，否则"接受"会把 Agent 卡住。
 */
export interface DialogPolicy {
  /** 默认答复。 */
  answer: 'accept' | 'dismiss'
  /**
   * `answer: 'accept'` 且遇到 `prompt` 时填进去的文本。
   *
   * 省略 = 用页面自己的 `defaultPrompt`：那是页面给的默认值，比我们编一个更诚实。
   */
  promptText?: string
}

/**
 * 出厂策略：**不阻塞、不替用户做决定**。
 *
 * `dismiss` 是"取消/留下"，它对页面是"什么都没发生"（`confirm` 得到 `false`、
 * `prompt` 得到 `null`），也是唯一不会替站点做副作用的答案。
 */
export const DEFAULT_DIALOG_POLICY: DialogPolicy = { answer: 'dismiss' }

/** 一个对话框被记下来之后的样子：它说了什么、我们答了什么、谁决定的。 */
export interface DialogRecord {
  /** 引擎报的类型：`alert` / `confirm` / `prompt` / `beforeunload`，或别的东西的原话。 */
  type: DialogKind
  /** 对话框上的文本。`beforeunload` 实测为空（Chromium 不把它的文案交出来）。 */
  message: string
  /** 页面给的默认输入（只有 `prompt` 有）。 */
  defaultPrompt: string
  /** 我们实际答的：接受还是拒绝。 */
  accept: boolean
  /** 接受 `prompt` 时替页面填进去的文本。 */
  promptText?: string
  /** 答复是谁定的，一句话，给模型看的。 */
  decidedBy: string
  /** 答复失败时引擎的原话（例如"对话框已经不在了"）。有它就说明这次答复没生效。 */
  answerError?: string
  /** 记录的时间戳（毫秒）。 */
  at: number
}

/** 一次决定的全部内容：答什么、为什么这么答、要不要说点别的。 */
export interface DialogPlan {
  /** 交回引擎的答复。 */
  answer: DialogAnswer
  /** 谁定的，一句话。 */
  decidedBy: string
}

/**
 * 决定一个对话框怎么答。
 *
 * `beforeunload` 不看策略：实测接受它只会让动作挂满超时、导航照样不通，
 * 所以它永远是 dismiss，而 `decidedBy` 把这件事如实说出来（模型据此知道
 * "这一页有未保存的改动，是它不让我走"）。
 *
 * @param kind - 引擎报的对话框类型。
 * @param policy - Agent 声明的策略。
 * @param defaultPrompt - 页面给 `prompt` 的默认输入。
 * @returns 答复与它的来由。
 */
export function planDialogAnswer(kind: DialogKind, policy: DialogPolicy, defaultPrompt: string): DialogPlan {
  if (kind === 'beforeunload') {
    return {
      answer: { accept: false },
      decidedBy: 'the fixed rule for beforeunload: refusing to leave is the only answer that neither loses the page',
    }
  }
  if (policy.answer === 'accept') {
    const answer: DialogAnswer = { accept: true }
    if (kind === 'prompt') {
      // 默认输入是页面自己给的：拿它当答复，比我们编一个更接近"用户按了确定"。
      answer.promptText = policy.promptText ?? defaultPrompt
    }
    return { answer, decidedBy: 'the answer the agent set for dialogs' }
  }
  return { answer: { accept: false }, decidedBy: 'the default answer: dismiss, so nothing is done on the page\'s behalf' }
}

/** 一条对话框记录的文本形式，给模型读。 */
export function describeDialog(record: DialogRecord): string {
  const what = record.message === '' ? '(no text: this dialog carries none)' : `"${record.message}"`
  const answer = record.accept ? 'accepted' : 'dismissed'
  const prompt =
    record.type === 'prompt' && record.accept
      ? ` with ${JSON.stringify(record.promptText ?? '')}${record.promptText === record.defaultPrompt ? ' (the page\'s own default)' : ''}`
      : ''
  return `${record.type} ${what} → ${answer}${prompt}${answerNote(record)} (${record.decidedBy})`
}

/**
 * 答复失败时那句补充，说得比"没生效"更准确。
 *
 * "对话框已经不在了"是最常见的一种：`beforeunload` 一旦被判定为"取消这次导航"，
 * 引擎自己就把它收了（实测），我们的 dismiss 到得比它晚——**结果正是我们要的那个**
 * （页面留下、动作立刻返回），所以这里说的是"它已经被收掉了"，而不是"我们没答上"。
 */
function answerNote(record: DialogRecord): string {
  if (record.answerError === undefined) return ''
  if (/No dialog is showing/.test(record.answerError)) {
    return ' — the engine had already closed it when the answer was sent, so nothing was left to answer'
  }
  return ` — the answer did not take effect: ${record.answerError}`
}

/**
 * 一条记录是不是值得占一行报给模型。
 *
 * `beforeunload` 尤其值得：它是"这一次点击为什么没有把页面带走"的唯一解释。
 */
export function dialogsWorthReporting(records: readonly DialogRecord[]): DialogRecord[] {
  return records.filter((record) => record.message !== '' || record.type === 'beforeunload')
}

/**
 * 动作期间"顺带发生的事"里，对话框那一半怎么写成给模型看的一行行。
 *
 * @param records - 这次动作期间被答复的对话框。
 * @returns 每行一句，空数组表示没什么可说的。
 */
export function describeDialogActivity(records: readonly DialogRecord[]): string[] {
  const worth = dialogsWorthReporting(records)
  if (worth.length === 0) return []
  return [`a dialog appeared while this action ran: ${worth.map(describeDialog).join('; ')}`]
}
