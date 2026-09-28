// The working agent reports its thread's status itself: the last action of
// every turn is a call to `report_thread_status`. The call lands in the
// thread log (item/started, with its arguments and the turn id) before the
// plugin's execute runs, so the log is the source of truth for reports
// (lib/facts.ts reads them there); execute only answers the agent with the
// topic the plugin keeps. The tool reaches a thread when its provider session
// is next constructed (thread start, resume after a daemon restart,
// environment switch, provider restart).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const REPORT_TOOL = "report_thread_status";
export const MAX_TOPIC_CHARS = 44;
/** Other bb threads a waiting thread can name as what it waits on. */
export const MAX_WAITING_ON = 10;
export const THREAD_ID = /^thr_[a-z0-9]+$/;

export const REPORT_STATES = ["done", "question", "waiting", "continuing"] as const;
export type ReportState = (typeof REPORT_STATES)[number];

export const reportSchema = z.object({
  state: z.enum(REPORT_STATES),
  about: z.string().trim().min(1).max(MAX_TOPIC_CHARS),
  topicChanged: z.boolean().optional(),
  done: z.string().max(300),
  stoppedAt: z.string().max(200),
  /** How many separate things the owner is asked (question); absent means one. */
  questionCount: z.number().int().min(1).max(20).optional(),
  /** The bb threads this one waits on (waiting). */
  waitingOnThreadIds: z.array(z.string().regex(THREAD_ID)).max(MAX_WAITING_ON).optional(),
});
export type ReportArgs = z.infer<typeof reportSchema>;

const INSTRUCTIONS = [
  "Отчёт о статусе треда для владельца. Последним действием каждого хода, прямо перед финальным ответом, вызови report_thread_status — и в ходе, который начался без сообщения (его разбудила фоновая задача). Если после отчёта в ход пришло новое сообщение или ответ на вопрос, в конце хода отчитайся снова. state совпадает со смыслом финального ответа; сам отчёт в ответе не упоминай — владелец видит его отдельно.",
  "- state — кто делает следующий шаг.",
  "  done: в объёме, о котором договорились в этом треде, ничего не осталось. Работа передана другому треду, и этот тред её результата не ждёт, — тоже done. Предложение сделать что-то сверх задачи («могу ещё…») — это done.",
  "  question: без действия владельца задачу не закончить — решить, ответить, войти, дать доступ или данные, смержить, проверить то, что ты сам проверить не можешь.",
  "  waiting: следующий шаг за кем-то другим — клиент, коллега, CI, внешний сервис, дочерний тред, чей результат нужен этому. Если задачу прислал другой тред и ты ждёшь его ответа, это тоже waiting.",
  "  continuing: следующий шаг за тобой, и ты продолжишь без чьего-либо действия — запустил фоновую задачу, мониторинг или отложенный запуск, который разбудит этот тред.",
  "- about — о чём весь тред целиком, с глагола, до 44 символов, без названия проекта и раздела (их видно в сайдбаре). Тему задаёт первый отчёт, ответ инструмента её повторяет; присылай её же. Если тред перешёл к другой задаче, пришли новую тему и topicChanged: true.",
  "- done — что в треде сделано к этому моменту, до 300 символов, с именами (файлы, PR, сервисы).",
  "- stoppedAt — на чём остановились, до 200 символов. При done — где результат (PR, ссылка, файл); при waiting — кого или что ждём; при continuing — чего ждёшь, чтобы продолжить. При question — просьба к владельцу, обращённая к нему и начатая с действия: «Выбери вариант обложки», «Проверь тему на телефоне и ноутбуке», без «Нужно от тебя» и «владелец должен». Если просьб несколько, начни с их числа («2 вопроса: …») и передай questionCount.",
  "- waitingOnThreadIds — при waiting, если ждёшь другие треды bb: их ID (thr_…).",
].join("\n");

/**
 * Who gets the tool: the owner's own threads. Children are named and
 * watched by their dispatcher; side chats and threads a plugin spawned
 * (helpers, automations, recaps) are service threads.
 */
export function wantsReportTool(thread: { parentThreadId: string | null }, origin: { pluginId: string | null }): boolean {
  return thread.parentThreadId === null && origin.pluginId === null;
}

export function registerReportTool(bb: Pick<BbPluginApi, "agents">, topicOf: (threadId: string) => string | null): void {
  bb.agents.registerTool({
    name: REPORT_TOOL,
    description:
      "Report this thread's status to the owner: what the whole thread is about, what is done, where it stopped and who makes the next step.",
    instructions: INSTRUCTIONS,
    parameters: reportSchema,
    presentation: { label: { pending: "Статус треда", completed: "Статус треда записан" }, suppress: true },
    execute: (params, ctx) => {
      const kept = topicOf(ctx.threadId);
      const topic = kept === null || params.topicChanged ? params.about : kept;
      return `Статус записан. Тема треда: ${topic}`;
    },
  });
  bb.agents.configure((ctx) => ({
    tools: wantsReportTool(ctx.thread, ctx.origin) ? [REPORT_TOOL] : [],
    skills: [],
  }));
}
