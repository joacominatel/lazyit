import type { Article, ArticleCategory, ArticleListItem, CreateArticle, FolderAccessRule } from "@lazyit/shared";
import { pool } from "../lib/api";
import { type Ctx, sortedEntries } from "../lib/context";
import { type ArticleKind, bodyFor, FOLDERS, type FolderSeed, SEEDED_FOLDERS, titleFor, topicFor } from "../lib/kb-content";
import { rngFor, slugify } from "../lib/rng";

type Folder = ArticleCategory & { accessRules?: unknown[] | null };

function selectFolders(seed: string, total: number): FolderSeed[] {
  const wanted = Math.max(0, total - SEEDED_FOLDERS.length);
  const optional = rngFor(seed, "folders").sample(
    FOLDERS.filter((f) => !f.keep),
    FOLDERS.length,
  );
  const drop = new Set(optional.slice(0, Math.max(0, FOLDERS.length - wanted)));
  return FOLDERS.filter((f) => !drop.has(f));
}

async function ensureFolders(ctx: Ctx): Promise<Map<string, string>> {
  const { api, report } = ctx;
  const all = await api.get<Folder[]>("/article-categories");
  const byId = new Map(all.map((f) => [f.id, f]));
  const pathOf = (f: Folder): string => {
    const parts: string[] = [];
    for (let cur: Folder | undefined = f, guard = 0; cur && guard < 50; cur = cur.parentId ? byId.get(cur.parentId) : undefined, guard++) {
      parts.unshift(cur.name);
    }
    return parts.join("/");
  };
  const byPath = new Map(all.map((f) => [pathOf(f), f]));
  const seeds: FolderSeed[] = [...SEEDED_FOLDERS.map((path) => ({ path })), ...selectFolders(ctx.seed, ctx.taxa.folders)];
  const depth = (p: string) => p.split("/").length;
  for (let d = 1; d <= Math.max(...seeds.map((s) => depth(s.path))); d++) {
    await pool(seeds.filter((s) => depth(s.path) === d), ctx.concurrency, async (seed, i) => {
      let folder = byPath.get(seed.path);
      if (folder) {
        report.skipped("kb folder");
      } else {
        const parts = seed.path.split("/");
        const parent = parts.length > 1 ? byPath.get(parts.slice(0, -1).join("/")) : undefined;
        if (parts.length > 1 && !parent) {
          report.failed("kb folder", seed.path, new Error("parent folder missing"));
          return;
        }
        try {
          folder = await api.post<Folder>("/article-categories", {
            name: parts.at(-1)!,
            order: i,
            ...(parent ? { parentId: parent.id } : {}),
            ...(d === 1 ? { description: `${parts[0]} knowledge` } : {}),
          });
          byPath.set(seed.path, folder);
          report.created("kb folder");
        } catch (err) {
          report.failed("kb folder", seed.path, err);
          return;
        }
      }
      if (!seed.rule) return;
      if (folder.hasAccessRules || (folder.accessRules?.length ?? 0) > 0) {
        report.skipped("kb folder access rule");
        return;
      }
      let rule: FolderAccessRule;
      if (seed.rule.kind === "role") {
        rule = { kind: "role", role: seed.rule.role };
      } else {
        const applicationId = ctx.applications.get(seed.rule.app);
        if (!applicationId) return;
        rule = { kind: "appGrant", applicationId };
      }
      try {
        await api.put(`/article-categories/${folder.id}/access-rules`, { accessRules: [rule] });
        report.created("kb folder access rule");
      } catch (err) {
        report.failed("kb folder access rule", seed.path, err);
      }
    });
  }
  return new Map([...byPath].filter(([path]) => seeds.some((s) => s.path === path)).map(([path, f]) => [path, f.id]));
}

const KINDS: [ArticleKind, number][] = [["howto", 34], ["troubleshoot", 24], ["runbook", 14], ["reference", 12], ["checklist", 9], ["faq", 7]];

interface ArticlePlan {
  slug: string;
  body: CreateArticle;
  links: ({ assetId: string } | { applicationId: string })[];
  revise: boolean;
  unpublish: boolean;
}

function planArticles(ctx: Ctx, folders: Map<string, string>): ArticlePlan[] {
  const paths = sortedEntries(folders).map(([p]) => p);
  const weighted = paths.map((p) => [p, p.split("/").length] as const);
  const assets = sortedEntries(ctx.assets).map(([, id]) => id);
  const apps = sortedEntries(ctx.applications).map(([, id]) => id);
  const slugs: string[] = [];
  const taken = new Set<string>();
  const plans: ArticlePlan[] = [];
  for (let a = 0; a < ctx.volumes.articles; a++) {
    const rng = rngFor(ctx.seed, "article", a);
    const folder = rng.weighted(weighted);
    let kind: ArticleKind = rng.weighted(KINDS);
    let topic = topicFor(folder, rng);
    let title = titleFor(kind, topic, rng);
    for (let attempt = 0; taken.has(slugify(title)) && attempt < 30; attempt++) {
      kind = rng.weighted(KINDS);
      topic = topicFor(folder, rng);
      title = titleFor(kind, topic, rng);
    }
    if (taken.has(slugify(title))) title = `${title} (${a + 1})`;
    const slug = slugify(title);
    taken.add(slug);
    const seeAlso = slugs.length > 0 && rng.chance(0.2) ? rng.pick(slugs) : undefined;
    slugs.push(slug);
    const unpublish = a % 23 === 7;
    const published = unpublish || rng.chance(0.7);
    const links: ArticlePlan["links"] = [];
    if (rng.chance(0.25)) {
      for (let k = rng.int(1, 3); k > 0; k--) {
        if (assets.length && rng.chance(0.6)) links.push({ assetId: rng.pick(assets) });
        else if (apps.length) links.push({ applicationId: rng.pick(apps) });
      }
    }
    plans.push({
      slug,
      body: {
        title,
        slug,
        content: bodyFor(kind, title, topic, rng, seeAlso),
        status: published ? "PUBLISHED" : "DRAFT",
        categoryId: folders.get(folder)!,
        ...(rng.chance(0.6) ? { excerpt: `${kind === "faq" ? "Answers about" : "Covers"} ${topic}.` } : {}),
      },
      links: links.filter((l, i) => links.findIndex((x) => JSON.stringify(x) === JSON.stringify(l)) === i),
      revise: rng.chance(0.12),
      unpublish,
    });
  }
  return plans;
}

export async function runKnowledgeBase(ctx: Ctx): Promise<void> {
  const { api, report } = ctx;
  const folders = await ensureFolders(ctx);
  const plans = planArticles(ctx, folders);
  const existing = new Set((await api.all<ArticleListItem>("/articles")).map((a) => a.slug));
  const progress = report.progress("articles", plans.length);
  await pool(plans, ctx.concurrency, async (plan) => {
    progress.tick();
    if (existing.has(plan.slug)) {
      report.skipped("kb article");
      return;
    }
    let article: Article;
    try {
      article = await api.post<Article>("/articles", plan.body);
      report.created("kb article");
    } catch (err) {
      report.failed("kb article", plan.slug, err);
      return;
    }
    for (const link of plan.links) {
      try {
        await api.post(`/articles/${article.id}/links`, link);
        report.created("kb article link");
      } catch (err) {
        report.failed("kb article link", plan.slug, err);
      }
    }
    try {
      if (plan.revise) {
        await api.patch(`/articles/${article.id}`, {
          content: `${plan.body.content}\n\n## Changelog\n\n- Clarified the prerequisites after a help desk review.`,
        });
        report.created("kb article revision");
      }
      if (plan.unpublish) {
        await api.post(`/articles/${article.id}/unpublish`);
        report.created("kb article unpublish");
      }
    } catch (err) {
      report.failed("kb article revision", plan.slug, err);
    }
  });
}

export const KB_ENTITIES = ["kb folder", "kb folder access rule", "kb article", "kb article link", "kb article revision", "kb article unpublish"];
