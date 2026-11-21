import { useState, useSyncExternalStore } from "react";
import { StrataWhy } from "../../data/api.ts";
import { clashes, settleClash, subscribeClashes, type Clash } from "../../data/mutate.ts";

// A write made offline that met a change made elsewhere: both texts side by side, settled with one press.

function Row({ c }: { c: Clash }) {
  const [said, setSaid] = useState("");
  const settle = (how: "mine" | "theirs" | "agent") => {
    setSaid("");
    settleClash(c.id, how).catch((e) => setSaid(StrataWhy(e, how === "agent" ? "couldn't file that" : "couldn't send that")));
  };
  return <li className="clash">
    <div className="clash-where">{c.where}</div>
    <div className="clash-two">
      <div><b>this device</b><p>{c.mine || <i>empty</i>}</p></div>
      <div><b>elsewhere, kept for now</b><p>{c.theirs || <i>empty</i>}</p></div>
    </div>
    <div className="clash-do">
      <button className="clash-agent" onClick={() => settle("agent")}>Hand to an agent</button>
      <button onClick={() => settle("mine")}>Keep mine</button>
      <button onClick={() => settle("theirs")}>Keep theirs</button>
      {said ? <span>{said}</span> : null}
    </div>
  </li>;
}

export default function ClashList() {
  const list = useSyncExternalStore(subscribeClashes, clashes);
  return <ul className="clash-list" aria-label="Clashes to settle">{list.map((c) => <Row key={c.id} c={c} />)}</ul>;
}
