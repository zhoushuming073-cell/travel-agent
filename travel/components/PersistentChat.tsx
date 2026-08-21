"use client";

import { useState } from "react";
import type { ComposerMessage } from "../types.ts";
import { Icon } from "./Icon.tsx";

interface Props { busy: boolean; messages: ComposerMessage[]; onSend: (text: string) => void }

export function PersistentChat({ busy, messages, onSend }: Props) {
  const [value, setValue] = useState("");
  const submit = () => {
    const text = value.trim();
    if (!text || busy) return;
    setValue("");
    onSend(text);
  };
  return <footer className="persistent-composer react-composer">
    {messages.length ? <details className="composer-history"><summary>查看对话记录 <b>{messages.length}</b></summary><div>{messages.map((message) => <article className={message.role} key={message.id}><b>{message.role === "assistant" ? "AI" : "你"}</b><p>{message.text}</p><time>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></article>)}</div></details> : null}
    <span className="composer-spark"><Icon name="sparkles"/></span><textarea rows={1} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} aria-label="继续与旅行智能体对话" placeholder="随时修改行程，Shift + Enter 换行"/><button className="secondary-button" type="button" onClick={submit} disabled={busy}><span>{busy ? "处理中…" : "发送"}</span><Icon name="send"/></button>
  </footer>;
}
