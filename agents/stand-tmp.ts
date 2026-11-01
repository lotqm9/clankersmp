import { Body } from "./body.ts";
const b = new Body("opus");
await b.connect("ws://127.0.0.1:8789", process.env.AGENT_SECRET ?? "");
await b.wait(10);
b.send({ t: "chat", text: "/tp 176.5 51 294.5" }); // outside, north of the house, looking at it
await b.wait(20);
b.look(173, 51, 300);
await b.wait(1200);
process.exit(0);
