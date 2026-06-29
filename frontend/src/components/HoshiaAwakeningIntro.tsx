import { type CSSProperties, FormEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import type { AiProfile, Session } from "../types";
import { appPath } from "../liveRoomApi";

const awakeningBgUrl = appPath("assets/hoshia-awakening-bg.jpg");
const awakeningCharacterUrl = appPath("assets/hoshia-awakening-character.png");
const awakeningSoloBgUrl = appPath("assets/hoshia-awakening-solo-bg.jpg");
const awakeningFinalBgUrl = appPath("assets/hoshia-awakening-final-bg.jpg");

type AwakeningIntroPhase =
  | "opening"
  | "focusedWait"
  | "chibiTransition"
  | "chibiEnter"
  | "catLine1"
  | "catLine2"
  | "innerTransition"
  | "innerQuestion"
  | "introReturn"
  | "innerStartled"
  | "askName"
  | "innerMustAnswerName"
  | "chooseName"
  | "confirmName"
  | "askStyle"
  | "chooseStyle"
  | "confirmStyle"
  | "askInterests"
  | "chooseInterests"
  | "interestsFeedback"
  | "askMemory"
  | "chooseMemory"
  | "finalSaving"
  | "finalSaved"
  | "finalUnsaved"
  | "finalError"
  | "finalBlackReady"
  | "finalEyeOpening"
  | "finalFollowLine"
  | "finalWhiteBloom"
  | "finalWhiteReady";

type ReplyStyle = AiProfile["reply_style"];

type AwakeningAnswers = {
  preferredName: string;
  replyStyle: ReplyStyle;
  replyStyleText: string;
  interests: string;
  memoryEnabled: boolean | null;
};

type CustomChoiceKind = "name" | "style" | "interests" | null;

const initialAwakeningAnswers: AwakeningAnswers = {
  preferredName: "",
  replyStyle: "friend",
  replyStyleText: "像朋友一样",
  interests: "",
  memoryEnabled: null
};

export function HoshiaAwakeningIntro({
  session,
  isDemo,
  onSessionUpdate,
  onDone
}: {
  session: Session;
  isDemo: boolean;
  onSessionUpdate: (user: Session) => void;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<AwakeningIntroPhase>("opening");
  const [typedText, setTypedText] = useState("");
  const [typingComplete, setTypingComplete] = useState(true);
  const [answers, setAnswers] = useState<AwakeningAnswers>(() => ({
    ...initialAwakeningAnswers,
    preferredName: session.nickname || session.username || "你"
  }));
  const [customKind, setCustomKind] = useState<CustomChoiceKind>(null);
  const [customDraft, setCustomDraft] = useState("");
  const [saveError, setSaveError] = useState("");
  const typingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (phase !== "opening") return;
    const timer = window.setTimeout(() => setPhase("focusedWait"), 7200);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "chibiTransition") return;
    const timer = window.setTimeout(() => setPhase("chibiEnter"), 560);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "innerTransition") return;
    const timer = window.setTimeout(() => setPhase("innerQuestion"), 620);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "finalEyeOpening") return;
    const timer = window.setTimeout(() => setPhase("finalFollowLine"), 7200);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "finalWhiteBloom") return;
    const timer = window.setTimeout(() => setPhase("finalWhiteReady"), 1450);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const dialogueText = awakeningDialogueText(phase, answers, saveError);
  const innerThought = awakeningInnerThought(phase);
  const choicePhase = isAwakeningChoicePhase(phase);
  const finalCenterText = phase === "finalBlackReady" ? "星港连接稳定……都准备就绪了喵。" : "";
  const isFinalImagePhase = phase === "finalEyeOpening" || phase === "finalFollowLine" || phase === "finalWhiteBloom" || phase === "finalWhiteReady";
  const isFinalBloomPhase = phase === "finalWhiteBloom" || phase === "finalWhiteReady";
  const showInnerContent = Boolean(innerThought) || choicePhase;
  const showChibi = isAwakeningCharacterPhase(phase);
  const showParticles = phase !== "opening" && phase !== "finalBlackReady" && !isFinalBloomPhase;
  const canAdvanceDialogue = nextAwakeningPhase(phase) !== phase;

  useEffect(() => {
    if (typingTimerRef.current) {
      window.clearInterval(typingTimerRef.current);
      typingTimerRef.current = null;
    }

    if (!dialogueText) {
      setTypedText("");
      setTypingComplete(true);
      return;
    }

    setTypedText("");
    setTypingComplete(false);
    let index = 0;
    const characters = Array.from(dialogueText);
    typingTimerRef.current = window.setInterval(() => {
      index += 1;
      setTypedText(characters.slice(0, index).join(""));
      if (index >= characters.length) {
        if (typingTimerRef.current) {
          window.clearInterval(typingTimerRef.current);
          typingTimerRef.current = null;
        }
        setTypingComplete(true);
      }
    }, 42);

    return () => {
      if (typingTimerRef.current) {
        window.clearInterval(typingTimerRef.current);
        typingTimerRef.current = null;
      }
    };
  }, [dialogueText]);

  function advanceIntro() {
    if (choicePhase || customKind || phase === "finalSaving") return;
    if (phase === "finalWhiteBloom") return;
    if (phase === "finalWhiteReady") {
      onDone();
      return;
    }
    if (dialogueText && !typingComplete) {
      if (typingTimerRef.current) {
        window.clearInterval(typingTimerRef.current);
        typingTimerRef.current = null;
      }
      setTypedText(dialogueText);
      setTypingComplete(true);
      return;
    }

    setPhase((current) => nextAwakeningPhase(current));
  }

  function chooseName(name: string) {
    setAnswers((current) => ({ ...current, preferredName: name.trim() || session.nickname || "你" }));
    setCustomKind(null);
    setCustomDraft("");
    setPhase("confirmName");
  }

  function chooseStyle(replyStyle: ReplyStyle, replyStyleText: string) {
    setAnswers((current) => ({ ...current, replyStyle, replyStyleText }));
    setCustomKind(null);
    setCustomDraft("");
    setPhase("confirmStyle");
  }

  function chooseInterests(interests: string) {
    setAnswers((current) => ({ ...current, interests }));
    setCustomKind(null);
    setCustomDraft("");
    setPhase("interestsFeedback");
  }

  async function chooseMemory(memoryEnabled: boolean) {
    const nextAnswers = { ...answers, memoryEnabled };
    setAnswers(nextAnswers);
    setCustomKind(null);
    setCustomDraft("");
    setSaveError("");
    setPhase("finalSaving");

    try {
      const nextUser = await saveAwakeningProfile(nextAnswers, session, isDemo);
      onSessionUpdate(nextUser);
      setPhase(memoryEnabled ? "finalSaved" : "finalUnsaved");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "save_failed");
      setPhase("finalError");
    }
  }

  function openCustom(kind: Exclude<CustomChoiceKind, null>) {
    setCustomKind(kind);
    setCustomDraft("");
  }

  function submitCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    const value = customDraft.trim();
    if (!value || !customKind) return;
    if (customKind === "name") chooseName(value.slice(0, 24));
    if (customKind === "style") chooseStyle("custom", value.slice(0, 48));
    if (customKind === "interests") chooseInterests(value.slice(0, 80));
  }

  function stopChoiceClick(event: MouseEvent<HTMLElement>) {
    event.stopPropagation();
  }

  return (
    <section
      className={`awakening-intro phase-${phase}${showChibi ? " is-character-phase" : ""}${showInnerContent ? " is-inner-phase" : ""}${isFinalImagePhase ? " is-final-image-phase" : ""}${isFinalBloomPhase ? " is-final-bloom-phase" : ""}`}
      style={{
        "--awakening-bg": `url(${awakeningBgUrl})`,
        "--awakening-solo-bg": `url(${awakeningSoloBgUrl})`,
        "--awakening-final-bg": `url(${awakeningFinalBgUrl})`
      } as CSSProperties}
      aria-label="Hoshia awakening intro"
      onClick={advanceIntro}
    >
      <div className="awakening-bg" aria-hidden="true" />
      <div className="awakening-vignette" aria-hidden="true" />
      {showParticles ? (
        <div className="awakening-particles" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : null}
      <div className="awakening-call" aria-hidden="true">
        <span className="awakening-rule" />
        <strong>信号接收成功……Hoshia 终于找到你了。</strong>
        <span className="awakening-rule" />
      </div>
      <p className="awakening-thought">是……谁在呼唤我？</p>
      <div className="eyelid eyelid-top" aria-hidden="true" />
      <div className="eyelid eyelid-bottom" aria-hidden="true" />
      {phase === "focusedWait" ? <span className="awakening-touch-cue">轻触继续</span> : null}
      {finalCenterText ? (
        <div className="awakening-final-center" aria-live="polite">{finalCenterText}</div>
      ) : null}
      {showChibi ? (
        <div className="awakening-chibi-stage" aria-hidden="true">
          <span className="chibi-aura" />
          <img src={awakeningCharacterUrl} alt="" draggable={false} />
        </div>
      ) : null}
      {dialogueText || showInnerContent ? (
        <section className="awakening-galgame-box" aria-live="polite">
          {dialogueText ? (
            <>
              <p key={phase} className={typingComplete ? "typing-complete" : "typing-active"}>{typedText}</p>
              {canAdvanceDialogue ? <span className="cat-continue-cue" aria-hidden="true">✦</span> : null}
            </>
          ) : null}
          {!dialogueText && showInnerContent ? (
            <span className="awakening-empty-cursor" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          ) : null}
          <span className="cat-paw paw-one" aria-hidden="true" />
          <span className="cat-paw paw-two" aria-hidden="true" />
          <span className="cat-tail" aria-hidden="true" />
        </section>
      ) : null}
      {innerThought ? (
        <div className="awakening-inner-question" aria-live="polite">
          <span className="awakening-rule" />
          <strong>{innerThought}</strong>
          <span className="awakening-rule" />
        </div>
      ) : null}
      {choicePhase ? (
        <div className="awakening-inner-question awakening-choice-panel" aria-live="polite" onClick={stopChoiceClick}>
          <AwakeningChoiceBranches
            phase={phase}
            session={session}
            customKind={customKind}
            customDraft={customDraft}
            onCustomDraftChange={setCustomDraft}
            onCustomSubmit={submitCustom}
            onChooseName={chooseName}
            onChooseStyle={chooseStyle}
            onChooseInterests={chooseInterests}
            onChooseMemory={(enabled) => void chooseMemory(enabled)}
            onOpenCustom={openCustom}
          />
        </div>
      ) : null}
      {isFinalBloomPhase ? <div className="awakening-white-bloom" aria-hidden="true" /> : null}
    </section>
  );
}

function AwakeningChoiceBranches({
  phase,
  session,
  customKind,
  customDraft,
  onCustomDraftChange,
  onCustomSubmit,
  onChooseName,
  onChooseStyle,
  onChooseInterests,
  onChooseMemory,
  onOpenCustom
}: {
  phase: AwakeningIntroPhase;
  session: Session;
  customKind: CustomChoiceKind;
  customDraft: string;
  onCustomDraftChange: (value: string) => void;
  onCustomSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onChooseName: (name: string) => void;
  onChooseStyle: (style: ReplyStyle, text: string) => void;
  onChooseInterests: (interests: string) => void;
  onChooseMemory: (enabled: boolean) => void;
  onOpenCustom: (kind: Exclude<CustomChoiceKind, null>) => void;
}) {
  if (phase === "chooseName") {
    return (
      <>
        <div className="awakening-choice-branches">
          <button type="button" onClick={() => onChooseName(session.nickname || session.username || "你")}>直接叫我名字</button>
          <button type="button" onClick={() => onChooseName("特别联系人")}>特别联系人</button>
          <button type="button" onClick={() => onChooseName("前辈")}>前辈</button>
          <button type="button" onClick={() => onOpenCustom("name")}>我自己说</button>
        </div>
        {customKind === "name" ? (
          <AwakeningCustomChoiceForm
            value={customDraft}
            placeholder="告诉猫猫一个称呼..."
            submitLabel="这样叫我"
            maxLength={24}
            onChange={onCustomDraftChange}
            onSubmit={onCustomSubmit}
          />
        ) : null}
      </>
    );
  }

  if (phase === "chooseStyle") {
    return (
      <>
        <div className="awakening-choice-branches">
          <button type="button" onClick={() => onChooseStyle("friend", "像朋友一样")}>像朋友一样</button>
          <button type="button" onClick={() => onChooseStyle("teasing_friend", "像损友一样")}>像损友一样</button>
          <button type="button" onClick={() => onChooseStyle("cool", "高冷一点")}>高冷一点</button>
          <button type="button" onClick={() => onOpenCustom("style")}>我自己说</button>
        </div>
        {customKind === "style" ? (
          <AwakeningCustomChoiceForm
            value={customDraft}
            placeholder="写下你想要的回应风格..."
            submitLabel="就是这样"
            maxLength={48}
            onChange={onCustomDraftChange}
            onSubmit={onCustomSubmit}
          />
        ) : null}
      </>
    );
  }

  if (phase === "chooseInterests") {
    return (
      <>
        <div className="awakening-choice-branches compact">
          <button type="button" onClick={() => onOpenCustom("interests")}>写给猫猫听</button>
          <button type="button" onClick={() => onChooseInterests("")}>你猜</button>
        </div>
        {customKind === "interests" ? (
          <AwakeningCustomChoiceForm
            value={customDraft}
            placeholder="比如游戏、音乐、动画、日常..."
            submitLabel="告诉猫猫"
            maxLength={80}
            onChange={onCustomDraftChange}
            onSubmit={onCustomSubmit}
          />
        ) : null}
      </>
    );
  }

  if (phase === "chooseMemory") {
    return (
      <div className="awakening-choice-branches compact">
        <button type="button" onClick={() => onChooseMemory(true)}>是</button>
        <button type="button" onClick={() => onChooseMemory(false)}>否</button>
      </div>
    );
  }

  return null;
}

function AwakeningCustomChoiceForm({
  value,
  placeholder,
  submitLabel,
  maxLength,
  onChange,
  onSubmit
}: {
  value: string;
  placeholder: string;
  submitLabel: string;
  maxLength: number;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="awakening-custom-choice" onSubmit={onSubmit}>
      <input
        value={value}
        maxLength={maxLength}
        autoFocus
        placeholder={placeholder}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="submit" disabled={!value.trim()}>{submitLabel}</button>
    </form>
  );
}

function awakeningDialogueText(phase: AwakeningIntroPhase, answers: AwakeningAnswers, saveError: string) {
  if (phase === "catLine1") return "欢迎停靠，星港旅人。Hoshia 一直在这里等你哦。";
  if (phase === "catLine2") return "刚才星网里传来了很温柔的讯号。它说……今天会有一位很重要的小星爪来到这里。";
  if (phase === "introReturn") return "是你哦。在真正进入星娅星港以前，Hoshia 想悄悄记住一点关于你的事。不是冷冰冰的资料……是为了以后你呼唤我的时候，我能更认真地陪着你。";
  if (phase === "askName") return "首先，可以告诉 Hoshia……该怎么称呼你吗？名字是很重要的坐标，猫猫会好好记住的。";
  if (phase === "confirmName") return `嗯，记住啦。从现在开始，Hoshia 就这样呼唤你：${answers.preferredName || "你"}。`;
  if (phase === "askStyle") return "那么，当你在星港呼唤我的时候……希望 Hoshia 用什么样的感觉回应你呢？";
  if (phase === "confirmStyle") return `原来如此……${answers.preferredName || "你"}喜欢“${answers.replyStyleText || "像朋友一样"}”这样的陪伴方式呀。Hoshia 会试着调整自己的频道。`;
  if (phase === "askInterests") return "不要着急哦，星港连接马上就稳定啦。Hoshia 还想知道……你平时会被什么东西点亮呢？";
  if (phase === "interestsFeedback") return answers.interests
    ? `嗯嗯，收到。“${answers.interests}”……这就是会让你发光的东西之一，对吧？Hoshia 把它放进星港的小小记忆灯里了。`
    : "嘿嘿，要让猫猫自己发现吗？那也很好。Hoshia 会在以后的聊天里，慢慢靠近你的星光。";
  if (phase === "askMemory") return "最后一个问题啦。Hoshia 可以把这些小小的连接记录保存下来吗？这样以后你 @ 我的时候，我就能更快认出属于你的星光。";
  if (phase === "finalSaving") return "Hoshia 正在把这份约定轻轻收好……星港核心同步中。";
  if (phase === "finalSaved") return "好哦。Hoshia 会把这份约定收进星港核心里。以后你呼唤我的时候，猫猫会更快找到你。";
  if (phase === "finalUnsaved") return "嗯嗯，没关系。不保存也没关系，Hoshia 还是会认真听你说话。陪伴不是因为记录才成立的。";
  if (phase === "finalError") return saveError ? "呜...刚才没能保存成功。猫猫先停在这里，等你再看看。" : "呜...刚才没能保存成功。";
  if (phase === "finalFollowLine") return "那么……牵好 Hoshia 的手。现在，就跟我一起进入星港吧。";
  return "";
}

function awakeningInnerThought(phase: AwakeningIntroPhase) {
  if (phase === "innerQuestion") return "那个人……是我吗？";
  if (phase === "innerStartled") return "欸……要记住我吗？";
  if (phase === "innerMustAnswerName") return "如果这是属于我的坐标……那我应该作出回答——";
  return "";
}

function isAwakeningChoicePhase(phase: AwakeningIntroPhase) {
  return phase === "chooseName" || phase === "chooseStyle" || phase === "chooseInterests" || phase === "chooseMemory";
}

function isAwakeningCharacterPhase(phase: AwakeningIntroPhase) {
  return phase === "chibiEnter" ||
    phase === "catLine1" ||
    phase === "catLine2" ||
    phase === "innerTransition" ||
    phase === "introReturn" ||
    phase === "askName" ||
    phase === "confirmName" ||
    phase === "askStyle" ||
    phase === "confirmStyle" ||
    phase === "askInterests" ||
    phase === "interestsFeedback" ||
    phase === "askMemory" ||
    phase === "finalSaving" ||
    phase === "finalSaved" ||
    phase === "finalUnsaved" ||
    phase === "finalError";
}

function nextAwakeningPhase(phase: AwakeningIntroPhase): AwakeningIntroPhase {
  if (phase === "opening") return "focusedWait";
  if (phase === "focusedWait") return "chibiTransition";
  if (phase === "chibiTransition" || phase === "innerTransition") return phase;
  if (phase === "chibiEnter") return "catLine1";
  if (phase === "catLine1") return "catLine2";
  if (phase === "catLine2") return "innerTransition";
  if (phase === "innerQuestion") return "introReturn";
  if (phase === "introReturn") return "innerStartled";
  if (phase === "innerStartled") return "askName";
  if (phase === "askName") return "innerMustAnswerName";
  if (phase === "innerMustAnswerName") return "chooseName";
  if (phase === "confirmName") return "askStyle";
  if (phase === "askStyle") return "chooseStyle";
  if (phase === "confirmStyle") return "askInterests";
  if (phase === "askInterests") return "chooseInterests";
  if (phase === "interestsFeedback") return "askMemory";
  if (phase === "askMemory") return "chooseMemory";
  if (phase === "finalSaved" || phase === "finalUnsaved") return "finalBlackReady";
  if (phase === "finalBlackReady") return "finalEyeOpening";
  if (phase === "finalEyeOpening") return phase;
  if (phase === "finalFollowLine") return "finalWhiteBloom";
  if (phase === "finalWhiteBloom" || phase === "finalWhiteReady") return phase;
  return phase;
}

async function saveAwakeningProfile(answers: AwakeningAnswers, session: Session, isDemo: boolean): Promise<Session> {
  const profile: AiProfile | null = answers.memoryEnabled ? {
    preferred_name: answers.preferredName || session.nickname || "你",
    reply_style: answers.replyStyle,
    reply_style_text: answers.replyStyleText || "像朋友一样",
    interests: answers.interests || "",
    memory_enabled: true
  } : null;

  if (isDemo) {
    return {
      ...session,
      onboarding_completed: true,
      ai_profile: profile
    };
  }

  const response = await fetch(appPath("api/account/onboarding"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile ? {
      preferred_name: profile.preferred_name,
      reply_style: profile.reply_style,
      reply_style_text: profile.reply_style_text,
      interests: profile.interests,
      memory_enabled: true
    } : {
      memory_enabled: false
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.user) {
    throw new Error(payload?.error || "onboarding_save_failed");
  }
  return payload.user;
}
