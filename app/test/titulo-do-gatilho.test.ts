import { test } from "node:test";
import assert from "node:assert/strict";
import { criarI18n } from "../renderer/lib/i18n.js";
import { escopoDoGatilho, linhaDoGatilho, tituloDoGatilho } from "../renderer/lib/titulo-do-gatilho.js";
import type { TriggerConfig } from "../src/config/types.js";

/** O nome do gatilho vem do modo configurado, e não do modo padrão do tipo. */

const pt = criarI18n({ idioma: "pt-BR", estrito: true });
const en = criarI18n({ idioma: "en", estrito: true });
const t = pt.t.bind(pt);

type Teams = Extract<TriggerConfig, { kind: "teams-inbox" }>;
type Slack = Extract<TriggerConfig, { kind: "slack-inbox" }>;
const teams = (parcial: Partial<Teams>): Teams => ({
  kind: "teams-inbox",
  mentions: false,
  dms: false,
  prLinks: false,
  agruparPrs: false,
  maxPrs: 5,
  channels: [],
  chats: [],
  chatsPendentes: 0,
  everyMinutes: 5,
  ...parcial,
});
const slack = (parcial: Partial<Slack>): Slack => ({ kind: "slack-inbox", mentions: false, dms: false, everyMinutes: 5, ...parcial });

test("Teams só com link de PR não se chama menção ou DM", () => {
  assert.equal(tituloDoGatilho(t, teams({ prLinks: true })), "Link de PR no Teams");
});

test("Teams com menção e DM é o nome de sempre", () => {
  assert.equal(tituloDoGatilho(t, teams({ mentions: true, dms: true })), "Menção ou DM no Teams");
});

test("cada combinação de modos do Teams tem o seu nome", () => {
  assert.equal(tituloDoGatilho(t, teams({ mentions: true })), "Menção no Teams");
  assert.equal(tituloDoGatilho(t, teams({ dms: true })), "DM no Teams");
  assert.equal(tituloDoGatilho(t, teams({ mentions: true, prLinks: true })), "Menção ou link de PR no Teams");
  assert.equal(tituloDoGatilho(t, teams({ dms: true, prLinks: true })), "DM ou link de PR no Teams");
  assert.equal(tituloDoGatilho(t, teams({ mentions: true, dms: true, prLinks: true })), "Menção, DM ou link de PR no Teams");
  assert.equal(tituloDoGatilho(t, teams({})), "Teams sem nenhum modo ligado");
});

test("Slack também segue o modo", () => {
  assert.equal(tituloDoGatilho(t, slack({ mentions: true, dms: true })), "Menção ou DM no Slack");
  assert.equal(tituloDoGatilho(t, slack({ mentions: true })), "Menção no Slack");
  assert.equal(tituloDoGatilho(t, slack({ dms: true })), "DM no Slack");
  assert.equal(tituloDoGatilho(t, slack({})), "Slack sem nenhum modo ligado");
});

test("gatilho sem modo mantém o título do tipo", () => {
  assert.equal(tituloDoGatilho(t, { kind: "manual" }), "Executar agora");
});

test("o escopo diz o primeiro canal ou chat e quantos mais", () => {
  const canal = { teamId: "t", channelId: "c", label: "Integrados - Devs" };
  const chat = { chatId: "19:x", label: "Ana" };
  assert.equal(escopoDoGatilho(t, teams({ prLinks: true, channels: [canal], chats: [chat] })), "Integrados - Devs + 1 chat");
  assert.equal(escopoDoGatilho(t, teams({ prLinks: true, channels: [canal] })), "Integrados - Devs");
  assert.equal(escopoDoGatilho(t, teams({ prLinks: true, chats: [chat, { chatId: "19:y", label: "Bia" }, { chatId: "19:z", label: "Caio" }] })), "Ana + 2 chats");
  assert.equal(escopoDoGatilho(t, teams({ prLinks: true, channels: [canal, { ...canal, channelId: "d" }], chats: [chat] })), "Integrados - Devs + 1 canal + 1 chat");
});

test("sem rótulo, o escopo conta em vez de mostrar o identificador", () => {
  assert.equal(escopoDoGatilho(t, teams({ chats: [{ chatId: "19:x@thread.v2" }] })), "1 chat");
});

test("sem canal nem chat, vale para todas as conversas", () => {
  assert.equal(escopoDoGatilho(t, teams({ prLinks: true })), "todas as conversas");
});

test("a linha junta título e escopo, e o Slack sem escopo fica só com o título", () => {
  const canal = { teamId: "t", channelId: "c", label: "Integrados - Devs" };
  const chat = { chatId: "19:x", label: "Ana" };
  assert.equal(linhaDoGatilho(t, teams({ prLinks: true, channels: [canal], chats: [chat] })), "Link de PR no Teams · Integrados - Devs + 1 chat");
  assert.equal(linhaDoGatilho(t, slack({ mentions: true, dms: true })), "Menção ou DM no Slack");
});

test("em inglês também", () => {
  assert.equal(tituloDoGatilho(en.t.bind(en), teams({ prLinks: true })), "PR link in Teams");
});
