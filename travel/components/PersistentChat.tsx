"use client";

import { useState } from "react";
import type { ComposerMessage } from "../types.ts";

interface Props { busy: boolean; messages: ComposerMessage[]; onSend: (text: string) => void }

export function PersistentChat({ busy, messages, onSend }: Props) {
  const [value, setValue] = useState("");
  const submit = () => {
    const text = value.trim();
    if (!text || busy) return;
    setValue("");
    onSend(text);
  };
  const latest = messages.at(-1);
  return <footer className="persistent-composer react-composer">
    {latest && <div className={`composer-latest ${latest.role}`}><b>{latest.role === "assistant" ? "AI" : "你"}</b><span>{latest.text}</span></div>}
    <span className="composer-spark">✦</span><input value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); }} aria-label="继续与旅行智能体对话" placeholder="随时修改：例如，只把第二天下午改轻松一些，其他日期保持不变"/><button className="secondary-button" type="button" onClick={submit} disabled={busy}>{busy ? "处理中…" : "发送"}</button>
  </footer>;
}

