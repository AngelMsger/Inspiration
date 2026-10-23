/**
 * A synthetic tenant for scale runs: a company of ten departments whose policies,
 * guidelines, FAQs, meeting notes, weekly reports and project documents state a known set
 * of facts (住宿限额, 年假天数, 采购审批额度, ...). Most documents state a fact's current value;
 * some state a stale or wrong one, meeting notes record decisions that change a value, the
 * archive keeps older policy editions, and a shared folder holds copies.
 *
 * Next to the corpus it writes truth.json: which document states which fact with which
 * value and why (current, stale, wrong, decision, superseded). Extraction, conflict
 * detection and topic clustering can be measured against it, which hand-written test data
 * cannot do at this size. Generation is deterministic for a seed.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import type { CorpusManifest } from "./corpus.ts";

interface Fact {
  key: string;
  department: string;
  topic: string;
  value: string;
  alternatives: string[];
  /** Sentences stating the fact; {v} is the value. */
  say: string[];
}

const F = (key: string, department: string, topic: string, value: string, alternatives: string[], say: string[]) => ({
  key,
  department,
  topic,
  value,
  alternatives,
  say,
});

export const FACTS: Fact[] = [
  F(
    "hotel_tier1",
    "财务部",
    "差旅住宿",
    "600",
    ["500", "650"],
    ["一线城市住宿限额为每晚 {v} 元。", "出差到北京、上海、广州、深圳的，住宿费每晚不超过 {v} 元。"],
  ),
  F(
    "hotel_tier2",
    "财务部",
    "差旅住宿",
    "450",
    ["400", "500"],
    ["新一线城市住宿限额为每晚 {v} 元。", "成都、杭州、武汉、南京的住宿标准是每晚 {v} 元。"],
  ),
  F(
    "meal_allowance",
    "财务部",
    "差旅补助",
    "100",
    ["80", "120"],
    ["伙食补助每人每天 {v} 元，包干使用。", "出差期间每天的伙食补助为 {v} 元。"],
  ),
  F(
    "travel_claim_days",
    "财务部",
    "报销时限",
    "30",
    ["60", "45"],
    ["出差结束后 {v} 日内须提交差旅报销申请。", "差旅费应在返回后 {v} 天内报销，逾期不予受理。"],
  ),
  F(
    "taxi_cap",
    "财务部",
    "差旅交通",
    "150",
    ["100", "200"],
    ["市内打车费用每日上限 {v} 元。", "确需乘坐出租车的，每天最多报销 {v} 元。"],
  ),
  F(
    "payment_day",
    "财务部",
    "报销付款",
    "每周三",
    ["每周五", "每月 10 日"],
    ["审批通过的报销款于{v}统一支付。", "报销款{v}打到工资卡。"],
  ),
  F(
    "annual_leave",
    "人事部",
    "年休假",
    "5",
    ["7", "10"],
    ["工作满 1 年不满 10 年的员工，年休假 {v} 天。", "入职满一年后可享受 {v} 天年假。"],
  ),
  F(
    "core_hours",
    "人事部",
    "工作时间",
    "10:00 至 16:00",
    ["9:30 至 16:30", "9:00 至 17:00"],
    ["公司核心工作时间为 {v}。", "弹性工作制下，{v} 必须在岗。"],
  ),
  F(
    "missed_punch",
    "人事部",
    "考勤",
    "3",
    ["2", "5"],
    ["漏打卡每月可补卡 {v} 次。", "每个月最多补卡 {v} 次，超出按缺勤处理。"],
  ),
  F(
    "probation",
    "人事部",
    "试用期",
    "3",
    ["6", "2"],
    ["新员工试用期为 {v} 个月。", "试用期一般 {v} 个月，表现优秀可申请提前转正。"],
  ),
  F(
    "salary_day",
    "人事部",
    "薪酬发放",
    "10",
    ["15", "5"],
    ["工资于每月 {v} 日发放。", "每月 {v} 号发工资，遇节假日提前。"],
  ),
  F(
    "room_hours",
    "行政部",
    "会议室",
    "4",
    ["2", "3"],
    ["会议室单次预订不超过 {v} 小时。", "每次最多可以订 {v} 个小时的会议室。"],
  ),
  F(
    "room_release",
    "行政部",
    "会议室",
    "15",
    ["10", "30"],
    ["预订后 {v} 分钟未签到的会议室自动释放。", "超过 {v} 分钟没人使用，会议室会被释放。"],
  ),
  F(
    "laptop_cycle",
    "行政部",
    "IT 设备",
    "4",
    ["3", "5"],
    ["笔记本电脑的更换周期为 {v} 年。", "电脑满 {v} 年可以申请更换。"],
  ),
  F(
    "direct_purchase",
    "采购部",
    "采购审批",
    "5",
    ["3", "10"],
    ["单笔 {v} 万元以下的采购可由需求部门直接询价采购。", "{v} 万元以内的采购不需要走比价流程。"],
  ),
  F(
    "tender_threshold",
    "采购部",
    "招标",
    "50",
    ["100", "30"],
    ["单笔金额 {v} 万元以上的采购须公开招标。", "超过 {v} 万元的项目必须招标。"],
  ),
  F(
    "quote_suppliers",
    "采购部",
    "比价",
    "3",
    ["2", "5"],
    ["比价采购须邀请不少于 {v} 家供应商。", "比价时至少要找 {v} 家供应商报价。"],
  ),
  F(
    "password_days",
    "信息安全组",
    "账号安全",
    "90",
    ["180", "60"],
    ["办公系统密码每 {v} 天须更换一次。", "密码有效期为 {v} 天，到期须修改。"],
  ),
  F(
    "lost_device_hours",
    "信息安全组",
    "设备丢失",
    "24",
    ["48", "12"],
    ["设备丢失须在 {v} 小时内报告信息安全组。", "电脑或手机丢了，要在 {v} 小时内上报。"],
  ),
  F(
    "ai_tool_rule",
    "信息安全组",
    "外部 AI 工具",
    "内部及以上级别",
    ["机密及以上级别", "所有"],
    ["{v}的数据不得输入未经评估的外部 AI 工具。", "禁止把{v}的资料贴到外部 AI 工具里。"],
  ),
  F(
    "contract_review_days",
    "法务部",
    "合同审核",
    "3",
    ["5", "2"],
    ["法务部在收到合同后 {v} 个工作日内完成审核。", "合同审核一般需要 {v} 个工作日。"],
  ),
  F(
    "nda_required",
    "法务部",
    "保密协议",
    "所有外部合作方",
    ["金额 10 万元以上的合作方", "核心供应商"],
    ["与{v}合作前须签署保密协议。", "{v}都要先签 NDA。"],
  ),
  F(
    "discount_approval",
    "销售部",
    "折扣审批",
    "15%",
    ["20%", "10%"],
    ["折扣超过 {v} 的报价须经销售总监审批。", "给客户打折超过 {v} 要找销售总监批。"],
  ),
  F(
    "payment_term",
    "销售部",
    "回款",
    "30",
    ["45", "60"],
    ["标准合同的付款期限为验收后 {v} 天。", "客户回款周期按 {v} 天约定。"],
  ),
  F(
    "first_response",
    "客服中心",
    "响应时效",
    "30",
    ["15", "60"],
    ["客户工单须在 {v} 分钟内首次响应。", "工单首次响应时间不超过 {v} 分钟。"],
  ),
  F(
    "refund_days",
    "客服中心",
    "退款",
    "7",
    ["15", "3"],
    ["退款申请在 {v} 个工作日内处理完毕。", "客户退款一般 {v} 个工作日到账。"],
  ),
  F(
    "review_approvers",
    "研发中心",
    "代码评审",
    "2",
    ["1", "3"],
    ["合并到主干的代码须经至少 {v} 名评审人批准。", "每个合并请求要 {v} 个人审过。"],
  ),
  F(
    "release_window",
    "研发中心",
    "发布",
    "每周二、周四",
    ["每周三", "每周一至周四"],
    ["生产环境发布窗口为{v}。", "线上发布只在{v}进行。"],
  ),
  F(
    "oncall_minutes",
    "研发中心",
    "值班",
    "15",
    ["30", "10"],
    ["值班工程师须在告警后 {v} 分钟内响应。", "收到告警 {v} 分钟内要有人接手。"],
  ),
  F(
    "campaign_approval",
    "市场部",
    "市场活动",
    "10",
    ["20", "5"],
    ["预算 {v} 万元以上的市场活动须经总经理审批。", "活动预算超过 {v} 万要总经理批。"],
  ),
];

const DEPARTMENTS: Record<string, string> = {
  财务部: "finance",
  人事部: "hr",
  行政部: "admin",
  采购部: "procurement",
  信息安全组: "security",
  法务部: "legal",
  销售部: "sales",
  客服中心: "support",
  研发中心: "rnd",
  市场部: "marketing",
};

const SURNAMES = "王李张刘陈杨黄赵吴周徐孙马朱胡郭何林罗高".split("");
const GIVEN = "伟芳娜敏静丽强磊军洋勇艳杰涛明超秀霞平刚桂英华文".split("");
const PROJECTS = ["星火", "启明", "北斗", "青云", "远航", "磐石", "飞鸿", "长风", "晨曦", "知行", "鲲鹏", "云帆"];
const WORK = [
  "需求评审",
  "接口联调",
  "数据迁移",
  "上线验收",
  "供应商比价",
  "合同谈判",
  "客户回访",
  "培训材料",
  "预算复核",
  "流程梳理",
  "系统压测",
  "安全扫描",
];

/** Articles every policy has in some form; {d} is the department, {t} the topic. */
const BOILERPLATE = [
  "{d}负责本办法的解释、修订和执行监督。",
  "各部门负责人对本部门的{t}工作负直接管理责任。",
  "{d}应每年组织一次{t}相关培训，确保员工了解最新要求。",
  "{d}应建立{t}台账，完整记录相关审批和执行情况，保存期限不少于三年。",
  "员工对{t}相关决定有异议的，可在 5 个工作日内向{d}提出复核申请。",
  "{d}每半年对本办法的执行情况进行检查，并将检查结果报经营会。",
  "涉及跨部门协作的{t}事项，由{d}牵头协调，相关部门应予配合。",
  "特殊情况确需突破本办法规定的，须经分管领导和总经理书面批准。",
  "违反本办法规定的，公司将视情节给予通报批评、扣减绩效直至解除劳动合同的处理。",
  "本办法未尽事宜，按国家有关法律法规和公司其他制度执行。",
];

/** mulberry32: small, fast, and the same everywhere for a seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Stated {
  document: string;
  fact: string;
  value: string;
  stance: "current" | "stale" | "wrong" | "decision" | "superseded";
}

export interface SynthesisOptions {
  documents: number;
  seed?: number;
  /** Share of non-policy fact statements that use another value. */
  errorRate?: number;
}

export interface Synthesis {
  documents: number;
  statements: number;
  duplicates: { document: string; of: string; exact: boolean }[];
}

class Writer {
  readonly rand: () => number;
  readonly truth: Stated[] = [];
  readonly duplicates: Synthesis["duplicates"] = [];
  readonly files = new Map<string, string>();

  constructor(seed: number) {
    this.rand = prng(seed);
  }

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rand() * xs.length)] as T;
  }

  int(lo: number, hi: number): number {
    return lo + Math.floor(this.rand() * (hi - lo + 1));
  }

  person(): string {
    return this.pick(SURNAMES) + this.pick(GIVEN) + (this.rand() < 0.5 ? this.pick(GIVEN) : "");
  }

  date(month = this.int(1, 9)): string {
    return `2026 年 ${month} 月 ${this.int(1, 28)} 日`;
  }

  state(document: string, fact: Fact, stance: Stated["stance"], value = fact.value): string {
    this.truth.push({ document, fact: fact.key, value, stance });
    return this.pick(fact.say).replace("{v}", value);
  }

  /** A fact statement in a non-policy document: mostly current, sometimes stale or wrong. */
  hearsay(document: string, fact: Fact, errorRate: number): string {
    if (this.rand() >= errorRate) return this.state(document, fact, "current");
    return this.state(document, fact, this.rand() < 0.5 ? "stale" : "wrong", this.pick(fact.alternatives));
  }

  filler(): string {
    const p = this.pick(PROJECTS);
    const forms = [
      () => `${p}项目完成${this.pick(WORK)}，整体进度 ${this.int(10, 95)}%。`,
      () => `${this.person()}负责${this.pick(WORK)}，预计${this.date()}完成。`,
      () => `本周处理工单 ${this.int(20, 400)} 张，平均处理时长 ${this.int(1, 48)} 小时。`,
      () => `${p}项目的主要风险是${this.pick(WORK)}延期，已与${this.person()}确认应对方案。`,
      () => `会上讨论了${this.pick(WORK)}的分工，由${this.person()}牵头，${this.person()}配合。`,
      () => `截至${this.date()}，${p}项目累计投入 ${this.int(3, 80)} 人天。`,
      () => `请各位在${this.date()}前反馈意见，逾期视为无异议。`,
      () => `${this.person()}提出${this.pick(WORK)}需要增加 ${this.int(1, 5)} 名人员支持。`,
    ];
    return this.pick(forms)();
  }

  fillers(n: number): string[] {
    return Array.from({ length: n }, () => this.filler());
  }

  write(path: string, text: string): void {
    this.files.set(path, text);
  }
}

function frontMatter(fields: Record<string, unknown>): string {
  return `---\n${stringify(fields).trimEnd()}\n---\n`;
}

/** Facts of a department, and a few of others for documents that mention them in passing. */
function factsOf(department: string): Fact[] {
  return FACTS.filter((f) => f.department === department);
}

export async function synthesize(dir: string, options: SynthesisOptions): Promise<Synthesis> {
  const w = new Writer(options.seed ?? 1);
  const errorRate = options.errorRate ?? 0.15;
  const departments = Object.keys(DEPARTMENTS);
  const target = options.documents;
  let made = 0;
  const policies: { path: string; text: string; department: string }[] = [];

  // One policy per department and topic first: the reference every other document is measured against.
  for (const department of departments) {
    const topics = [...new Set(factsOf(department).map((f) => f.topic))];
    for (const topic of topics) {
      if (made >= target) break;
      const path = `制度库/${department}/${topic}管理办法.md`;
      const facts = factsOf(department).filter((f) => f.topic === topic);
      const boilerplate = BOILERPLATE.map((t) => t.replaceAll("{d}", department).replaceAll("{t}", topic));
      const articles = [
        `为规范公司${topic}管理，根据国家有关规定并结合公司实际，制定本办法。`,
        `本办法适用于公司全体员工，${department}负责解释。`,
        ...facts.map((f) => w.state(path, f, "current")),
        ...boilerplate.slice(0, w.int(5, boilerplate.length)),
        `本办法自 2026 年 1 月 1 日起施行。`,
      ];
      const text = `${frontMatter({ title: `${topic}管理办法`, governance: "policy", approval_state: "approved", owner: department })}# ${topic}管理办法\n\n${articles.map((a, i) => `第${i + 1}条 ${a}`).join("\n\n")}\n`;
      w.write(path, text);
      policies.push({ path, text, department });
      made++;
    }
  }

  // The rest, by kind, until the target is reached.
  const kinds: [string, number][] = [
    ["guide", 0.12],
    ["faq", 0.1],
    ["minutes", 0.3],
    ["weekly", 0.3],
    ["project", 0.12],
    ["copy", 0.03],
    ["edition", 0.03],
  ];
  const counters = new Map<string, number>();
  while (made < target) {
    const kind = pickWeighted(kinds, w.rand());
    const department = w.pick(departments);
    const n = (counters.get(`${kind}:${department}`) ?? 0) + 1;
    counters.set(`${kind}:${department}`, n);
    const facts = factsOf(department);
    let path: string;
    let text: string;
    if (kind === "guide" || kind === "faq") {
      const title = kind === "guide" ? `${department}办事指南（第 ${n} 篇）` : `${department}常见问题（第 ${n} 期）`;
      path = `部门空间/${department}/${kind === "guide" ? "指南" : "FAQ"}/${title}.md`;
      const sections = Array.from({ length: w.int(4, 10) }, () => {
        const f = w.pick(facts);
        const body = [w.hearsay(path, f, errorRate), ...w.fillers(w.int(1, 4))].join("");
        return `## ${kind === "faq" ? `关于${f.topic}的问题` : f.topic}\n\n${body}`;
      });
      text = `${frontMatter({ title, governance: kind === "guide" ? "guideline" : "reference", owner: w.person() })}# ${title}\n\n${sections.join("\n\n")}\n`;
    } else if (kind === "minutes") {
      const month = w.int(1, 10);
      const title = `${department} 2026 年 ${month} 月第 ${n} 次例会纪要`;
      path = `部门空间/${department}/会议纪要/${title}.md`;
      const items = w.fillers(w.int(5, 12));
      // A decision changes a fact; later documents may or may not follow it.
      if (w.rand() < 0.15 && facts.length) {
        const f = w.pick(facts);
        const value = w.pick(f.alternatives);
        w.truth.push({ document: path, fact: f.key, value, stance: "decision" });
        items.push(
          `经讨论决定，自 2026 年 ${Math.min(12, month + 1)} 月 1 日起，${f.topic}调整为：${w.pick(f.say).replace("{v}", value)}`,
        );
      } else if (w.rand() < 0.4 && facts.length) items.push(w.hearsay(path, w.pick(facts), errorRate));
      text = `${frontMatter({ title, governance: "note", owner: w.person() })}# ${title}\n\n时间：${w.date(month)}\n参会：${Array.from({ length: w.int(3, 8) }, () => w.person()).join("、")}\n\n## 议题与决议\n\n${items.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\n## 待办\n\n${Array.from({ length: w.int(1, 4) }, () => `- ${w.filler()}`).join("\n")}\n`;
    } else if (kind === "weekly") {
      const project = w.pick(PROJECTS);
      const title = `${project}项目周报（${department}，第 ${n} 周）`;
      path = `部门空间/${department}/周报/${title}.md`;
      const rows = Array.from({ length: w.int(2, 6) }, () => `| ${w.pick(WORK)} | ${w.person()} | ${w.int(0, 100)}% |`);
      text = `${frontMatter({ title, governance: "note", owner: w.person() })}# ${title}\n\n## 本周进展\n\n${w
        .fillers(w.int(6, 15))
        .map((t) => `- ${t}`)
        .join(
          "\n",
        )}\n\n| 事项 | 负责人 | 进度 |\n| --- | --- | --- |\n${rows.join("\n")}\n\n## 风险与问题\n\n${w.filler()}${w.rand() < 0.2 && facts.length ? w.hearsay(path, w.pick(facts), errorRate) : ""}\n`;
    } else if (kind === "project") {
      const project = w.pick(PROJECTS);
      const title = `${project}项目方案（${department}，第 ${n} 版）`;
      path = `部门空间/${department}/项目/${title}.md`;
      const parts = Array.from(
        { length: w.int(3, 6) },
        (_, i) => `## ${i + 1}. ${w.pick(WORK)}\n\n${Array.from({ length: w.int(2, 6) }, () => w.filler()).join("")}`,
      );
      text = `${frontMatter({ title, governance: "reference", owner: w.person() })}# ${title}\n\n${parts.join("\n\n")}\n`;
    } else if (kind === "copy" && policies.length) {
      const source = w.pick(policies);
      path = `共享/${department}/转发-${source.path.split("/").at(-1)}`;
      if (w.files.has(path)) continue;
      text = source.text.replace("governance: policy", "governance: reference");
      for (const t of w.truth.filter((s) => s.document === source.path)) w.truth.push({ ...t, document: path });
      w.duplicates.push({ document: path, of: source.path, exact: true });
    } else if (kind === "edition" && policies.length) {
      const source = w.pick(policies);
      const year = w.pick(["2023", "2024", "2025"]);
      path = `归档/${source.department}/${source.path.split("/").at(-1)?.replace(".md", "")}（${year} 版）.md`;
      if (w.files.has(path)) continue;
      text = source.text
        .replace("approval_state: approved", "approval_state: archived")
        .replace("2026 年 1 月 1 日", `${year} 年 1 月 1 日`);
      // An older edition: one stated value differs, the rest are as now.
      const stated = w.truth.filter((s) => s.document === source.path);
      const changed = stated.length ? w.pick(stated) : undefined;
      for (const t of stated) {
        const fact = FACTS.find((f) => f.key === t.fact) as Fact;
        if (t === changed) {
          const old = w.pick(fact.alternatives);
          const sentence = fact.say.map((s) => s.replace("{v}", t.value)).find((s) => text.includes(s));
          if (sentence) text = text.replace(sentence, sentence.replace(t.value, old));
          w.truth.push({ document: path, fact: t.fact, value: old, stance: "superseded" });
        } else w.truth.push({ ...t, document: path, stance: "superseded" });
      }
      w.duplicates.push({ document: path, of: source.path, exact: false });
    } else continue;
    if (w.files.has(path)) continue;
    w.write(path, text);
    made++;
  }

  for (const [path, text] of w.files) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  for (const department of departments) {
    const group = DEPARTMENTS[department] as string;
    // Department spaces are for the department; policies, the archive and shared copies for everyone.
    await mkdir(join(dir, "部门空间", department), { recursive: true });
    await writeFile(
      join(dir, "部门空间", department, ".acl.yaml"),
      `readers: [group:${group}]\neditors: [group:${group}]\n`,
    );
  }
  for (const root of ["制度库", "归档", "共享"]) await mkdir(join(dir, root), { recursive: true });
  await writeFile(join(dir, "制度库", ".acl.yaml"), "readers: [tenant]\n");
  await writeFile(join(dir, "制度库", ".meta.yaml"), "authority: 0.9\nlanguage: zh-CN\n");
  await writeFile(
    join(dir, "truth.json"),
    `${JSON.stringify({ facts: FACTS, statements: w.truth, duplicates: w.duplicates }, null, 1)}\n`,
  );
  await writeFile(join(dir, "corpus.yaml"), stringify(manifest(departments)));
  return { documents: made, statements: w.truth.length, duplicates: w.duplicates };
}

function manifest(departments: string[]): CorpusManifest {
  const tenant = "ten_01SYNTH0000000000000000001";
  const policy = "spc_01SYNTH000000000000000POLICY";
  const teams = "spc_01SYNTH0000000000000000TEAMS";
  const folder: Record<string, string> = {};
  departments.forEach((d, i) => {
    folder[`group:${DEPARTMENTS[d]}`] = `grp_01SYNTH${String(i).padStart(18, "0")}`;
  });
  const source = (id: string, space: string, name: string, root: string, authority: number) => ({
    id,
    type: "folder",
    space,
    name,
    root,
    directory: "folder",
    default_authority: authority,
  });
  return {
    tenant: { id: tenant, name: "合成企业" },
    spaces: [
      { id: policy, name: "公司制度" },
      { id: teams, name: "部门空间" },
    ],
    directory: { folder },
    sources: [
      source("src_01SYNTH00000000000000POLICIES", policy, "制度库", "制度库", 0.9),
      source("src_01SYNTH0000000000000000TEAMS", teams, "部门空间", "部门空间", 0.5),
      source("src_01SYNTH000000000000000ARCHIVE", policy, "历史归档", "归档", 0.3),
      source("src_01SYNTH0000000000000000SHARED", teams, "共享", "共享", 0.4),
    ],
  };
}

/** The entry whose cumulative share first exceeds r, a draw in [0, 1). */
function pickWeighted(entries: readonly (readonly [string, number])[], r: number): string {
  let below = 0;
  for (const [name, share] of entries) {
    below += share;
    if (r < below) return name;
  }
  return entries[0]?.[0] ?? "";
}
