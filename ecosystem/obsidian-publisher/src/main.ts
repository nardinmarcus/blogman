import {
  Plugin,
  Notice,
  TFile,
  requestUrl,
  MarkdownView,
} from "obsidian";
import {
  BlogmanSettings,
  DEFAULT_SETTINGS,
  BlogmanSettingTab,
} from "./settings";
import { PublishModal, PublishOptions, PublishResult } from "./publish-modal";

// Media file extensions
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"];
const AUDIO_EXTS = ["mp3", "wav", "ogg", "m4a", "flac", "aac"];
const VIDEO_EXTS = ["mp4", "webm", "mov", "avi", "mkv"];
const MEDIA_EXTS = [...IMAGE_EXTS, ...AUDIO_EXTS, ...VIDEO_EXTS];

interface UploadResult {
  success: boolean;
  url?: string;
  type?: string;
  name?: string;
  error?: string;
}

interface PostResult {
  success: boolean;
  slug?: string;
  id?: number;
  articleId?: number;
  version?: number;
  legacy?: boolean;
  error?: string;
}

/** Per-note versioned write state (drives update-by-version idempotency). */
interface PublishStateEntry {
  articleId: number;
  version: number;
  status: "draft" | "published";
}

type PublishState = Record<string, PublishStateEntry>;

export default class BlogmanPublisher extends Plugin {
  settings: BlogmanSettings = DEFAULT_SETTINGS;
  private statusBarEl: HTMLElement | null = null;
  private publishState: PublishState = {};

  async onload() {
    await this.loadSettings();

    // 1. Ribbon icon (left sidebar)
    this.addRibbonIcon("upload-cloud", "发布到 Namoo Blog", async () => {
      await this.publishCurrentNote();
    });

    // 2. Command palette
    this.addCommand({
      id: "publish-to-namoo-blog",
      name: "发布到 Namoo Blog",
      editorCallback: () => {
        this.publishCurrentNote();
      },
    });

    // 3. Status bar (bottom)
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.setText("Namoo Blog");
    this.statusBarEl.addClass("mod-clickable");
    this.statusBarEl.onClickEvent(() => {
      this.publishCurrentNote();
    });

    // 4. Editor context menu (right-click in editor)
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu) => {
        menu.addItem((item) => {
          item
            .setTitle("发布到 Namoo Blog")
            .setIcon("upload-cloud")
            .onClick(() => this.publishCurrentNote());
        });
      })
    );

    // 5. File menu (right-click on file in explorer)
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && file.extension === "md") {
          menu.addItem((item) => {
            item
              .setTitle("发布到 Namoo Blog")
              .setIcon("upload-cloud")
              .onClick(() => this.publishFile(file));
          });
        }
      })
    );

    // Settings tab
    this.addSettingTab(new BlogmanSettingTab(this.app, this));
  }

  async loadSettings() {
    const data = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    if (data && typeof data === "object" && "publishState" in data) {
      const state = (data as { publishState?: unknown }).publishState;
      if (state && typeof state === "object") {
        this.publishState = state as PublishState;
      }
    }
  }

  async saveSettings() {
    await this.saveData({ ...this.settings, publishState: this.publishState });
  }

  // ─── Status Bar Helpers ──────────────────────────────────

  private setStatus(text: string, revertMs?: number) {
    if (!this.statusBarEl) return;
    this.statusBarEl.setText(text);
    if (revertMs) {
      setTimeout(() => {
        if (this.statusBarEl) this.statusBarEl.setText("Namoo Blog");
      }, revertMs);
    }
  }

  // ─── Publish Entry Points ────────────────────────────────

  /**
   * Publish the currently active markdown note
   */
  async publishCurrentNote() {
    if (!this.settings.apiToken) {
      new Notice("请先在设置中配置 API Token");
      return;
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView || !activeView.file) {
      new Notice("请先打开一个 Markdown 文件");
      return;
    }

    const file = activeView.file;
    const content = await this.app.vault.read(file);
    const title = this.extractTitle(content, file);

    this.openPublishModal(file, content, title);
  }

  /**
   * Publish a specific file (from file explorer context menu)
   */
  async publishFile(file: TFile) {
    if (!this.settings.apiToken) {
      new Notice("请先在设置中配置 API Token");
      return;
    }

    const content = await this.app.vault.read(file);
    const title = this.extractTitle(content, file);

    this.openPublishModal(file, content, title);
  }

  /**
   * Open the publish modal for a given file
   */
  private openPublishModal(file: TFile, content: string, title: string) {
    const modal = new PublishModal(
      this.app,
      this,
      title,
      async (options, onProgress) => {
        this.setStatus("Namoo Blog \u23F3");
        try {
          const result = await this.doPublish(file, content, options, onProgress);
          if (result.success) {
            this.setStatus("Namoo Blog \u2713", 3000);
          } else {
            this.setStatus("Namoo Blog \u2717", 5000);
          }
          return result;
        } catch (e) {
          this.setStatus("Qiaomu Blog \u2717", 5000);
          throw e;
        }
      }
    );
    modal.open();
  }

  // ─── Publish Logic ───────────────────────────────────────

  /**
   * Execute the actual publish flow. Called from the modal.
   */
  async doPublish(
    file: TFile,
    content: string,
    options: PublishOptions,
    onProgress: (msg: string) => void
  ): Promise<PublishResult> {
    onProgress("正在准备文件...");

    // 1. Strip YAML frontmatter from content for publishing
    const bodyContent = this.stripFrontmatter(content);
    const description = this.extractDescription(content);

    // 2. Collect all media references (local + remote)
    const localRefs = this.findLocalMediaRefs(bodyContent, file);
    const remoteRefs = this.findRemoteImageRefs(bodyContent);
    const totalFiles = localRefs.length + remoteRefs.length;

    let processedContent = bodyContent;
    let uploadedCount = 0;
    let failedCount = 0;

    // 3. Upload local files
    for (const ref of localRefs) {
      uploadedCount++;
      if (totalFiles > 0) {
        onProgress(`正在上传文件 ${uploadedCount}/${totalFiles}...`);
      }

      try {
        const fileData = await this.readLocalFile(ref.resolvedPath);
        if (!fileData) {
          failedCount++;
          continue;
        }

        const result = await this.uploadFile(
          fileData.buffer,
          fileData.name,
          fileData.mimeType
        );

        if (result.success && result.url) {
          const fullUrl = this.toAbsoluteUrl(result.url);
          processedContent = processedContent.split(ref.original).join(
            ref.isWikilink
              ? `![${fileData.name}](${fullUrl})`
              : ref.original.replace(ref.src, fullUrl)
          );
        } else {
          failedCount++;
        }
      } catch (e) {
        console.error(`Failed to upload local file: ${ref.src}`, e);
        failedCount++;
      }
    }

    // 4. Re-upload remote images
    for (const ref of remoteRefs) {
      uploadedCount++;
      if (totalFiles > 0) {
        onProgress(`正在上传文件 ${uploadedCount}/${totalFiles}...`);
      }

      try {
        const downloaded = await this.downloadRemoteImage(ref.src);
        if (!downloaded) {
          failedCount++;
          continue;
        }

        const result = await this.uploadFile(
          downloaded.buffer,
          downloaded.name,
          downloaded.mimeType
        );

        if (result.success && result.url) {
          const fullUrl = this.toAbsoluteUrl(result.url);
          processedContent = processedContent.split(ref.src).join(fullUrl);
        } else {
          failedCount++;
        }
      } catch (e) {
        console.error(`Failed to re-upload remote image: ${ref.src}`, e);
        failedCount++;
      }
    }

    // 5. Create post
    onProgress("正在创建文章...");
    const postResult = await this.createPost(
      file,
      options.title,
      processedContent,
      options.status,
      options.category,
      description
    );

    if (postResult.success) {
      return {
        success: true,
        slug: postResult.slug,
        uploadedCount: totalFiles - failedCount,
        failedCount,
        totalFiles,
      };
    } else {
      return {
        success: false,
        error: postResult.error || "未知错误",
        uploadedCount: totalFiles - failedCount,
        failedCount,
        totalFiles,
      };
    }
  }

  // ─── Content Helpers ─────────────────────────────────────

  /**
   * Extract title: YAML frontmatter title > first # heading > filename
   */
  extractTitle(content: string, file: TFile): string {
    // Try YAML frontmatter
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const titleMatch = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
      if (titleMatch) {
        return titleMatch[1].trim();
      }
    }

    // Try first heading
    const headingMatch = content.match(/^#\s+(.+)$/m);
    if (headingMatch) {
      return headingMatch[1].trim();
    }

    // Fallback to filename
    return file.basename;
  }

  extractDescription(content: string): string {
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) {
      return "";
    }

    const lines = fmMatch[1].split(/\r?\n/);
    const keys = new Set(["description", "summary", "excerpt", "abstract"]);

    for (let index = 0; index < lines.length; index += 1) {
      const field = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[index]);
      if (!field || !keys.has(field[1].trim().toLowerCase())) continue;

      const rawValue = field[2].trim();
      const value = /^[>|][-+]?$/.test(rawValue)
        ? this.readFrontmatterBlock(lines, index, rawValue.startsWith(">") ? " " : "\n")
        : rawValue
          ? this.stripSymmetricQuotes(rawValue)
          : this.readFrontmatterBlock(lines, index, " ");

      const description = value.trim().replace(/\s+/g, " ").slice(0, 160);
      if (description) return description;
    }

    return "";
  }

  readFrontmatterBlock(lines: string[], startIndex: number, separator: string): string {
    const values: string[] = [];

    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^[A-Za-z0-9_-]+\s*:/.test(line)) break;
      if (!line.trim()) continue;
      if (!/^\s+/.test(line)) break;
      values.push(line.trim());
    }

    return values.join(separator);
  }

  stripSymmetricQuotes(value: string): string {
    const trimmed = value.trim();
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];

    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }

    return trimmed;
  }

  /**
   * Strip YAML frontmatter from content
   */
  stripFrontmatter(content: string): string {
    return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "");
  }

  /**
   * Find local media references in markdown
   * Matches: ![alt](./path) ![alt](path) ![[wikilink.png]]
   */
  findLocalMediaRefs(
    content: string,
    sourceFile: TFile
  ): Array<{
    original: string;
    src: string;
    resolvedPath: string;
    isWikilink: boolean;
  }> {
    const refs: Array<{
      original: string;
      src: string;
      resolvedPath: string;
      isWikilink: boolean;
    }> = [];
    const seen = new Set<string>();

    // Standard markdown: ![alt](path) or ![alt](<path with spaces>)
    const mdRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let match;
    while ((match = mdRegex.exec(content)) !== null) {
      let src = match[2].trim();

      // Strip angle brackets: <../path/to/file.png> → ../path/to/file.png
      if (src.startsWith("<") && src.endsWith(">")) {
        src = src.slice(1, -1);
      }

      // Skip URLs (http/https) and already-uploaded blogman URLs
      if (src.startsWith("http://") || src.startsWith("https://")) {
        continue;
      }
      // Skip data URIs
      if (src.startsWith("data:")) {
        continue;
      }

      if (seen.has(src)) continue;
      seen.add(src);

      const ext = src.split(".").pop()?.toLowerCase() || "";
      if (!MEDIA_EXTS.includes(ext)) continue;

      const resolvedPath = this.resolveLocalPath(src, sourceFile);
      if (resolvedPath) {
        refs.push({
          original: match[0],
          src,
          resolvedPath,
          isWikilink: false,
        });
      }
    }

    // Obsidian wikilinks: ![[file.png]] or ![[file.png|alt]]
    const wikiRegex = /!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;
    while ((match = wikiRegex.exec(content)) !== null) {
      const linkPath = match[1].trim();

      if (seen.has(linkPath)) continue;
      seen.add(linkPath);

      const ext = linkPath.split(".").pop()?.toLowerCase() || "";
      if (!MEDIA_EXTS.includes(ext)) continue;

      const resolved = this.resolveWikilink(linkPath, sourceFile);
      if (resolved) {
        refs.push({
          original: match[0],
          src: linkPath,
          resolvedPath: resolved,
          isWikilink: true,
        });
      }
    }

    return refs;
  }

  /**
   * Find remote (non-blogman) image URLs in markdown
   */
  findRemoteImageRefs(
    content: string
  ): Array<{ original: string; src: string }> {
    const refs: Array<{ original: string; src: string }> = [];
    const seen = new Set<string>();
    const apiHost = new URL(this.settings.apiUrl).host;

    // Standard markdown images with http(s) URLs
    const mdRegex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
    let match;
    while ((match = mdRegex.exec(content)) !== null) {
      const src = match[2].trim();

      // Skip blogman URLs - already hosted
      try {
        const url = new URL(src);
        if (url.host === apiHost) continue;
      } catch {
        continue;
      }

      if (seen.has(src)) continue;
      seen.add(src);

      // Only process image URLs
      const ext = src.split("?")[0].split(".").pop()?.toLowerCase() || "";
      if (IMAGE_EXTS.includes(ext) || this.looksLikeImageUrl(src)) {
        refs.push({ original: match[0], src });
      }
    }

    return refs;
  }

  /**
   * Heuristic: does a URL look like an image?
   */
  looksLikeImageUrl(url: string): boolean {
    const lower = url.toLowerCase();
    return (
      lower.includes("/image") ||
      lower.includes("img") ||
      lower.includes("photo") ||
      lower.includes("pic") ||
      lower.includes("screenshot") ||
      lower.includes("imgur.com") ||
      lower.includes("i.redd.it") ||
      lower.includes("pbs.twimg.com")
    );
  }

  /**
   * Resolve a relative path from the source file's directory
   */
  resolveLocalPath(src: string, sourceFile: TFile): string | null {
    // Decode URL-encoded characters (%20 → space, etc.)
    let cleaned = decodeURIComponent(src);
    // Remove leading ./
    cleaned = cleaned.replace(/^\.\//, "");

    // Get parent folder path
    const parentPath = sourceFile.parent?.path || "";

    // Handle ../ relative paths
    const baseParts = parentPath.split("/");
    const srcParts = cleaned.split("/");
    while (srcParts[0] === "..") {
      srcParts.shift();
      baseParts.pop();
    }
    const fullPath = [...baseParts, ...srcParts].filter(Boolean).join("/");

    // Check if file exists in vault
    const file = this.app.vault.getAbstractFileByPath(fullPath);
    if (file instanceof TFile) {
      return file.path;
    }

    // Try without parent (root-relative)
    const rootFile = this.app.vault.getAbstractFileByPath(cleaned);
    if (rootFile instanceof TFile) {
      return rootFile.path;
    }

    return null;
  }

  /**
   * Resolve Obsidian wikilink to vault file path
   */
  resolveWikilink(linkPath: string, sourceFile: TFile): string | null {
    const resolved = this.app.metadataCache.getFirstLinkpathDest(
      linkPath,
      sourceFile.path
    );
    if (resolved instanceof TFile) {
      return resolved.path;
    }
    return null;
  }

  /**
   * Read a local vault file as binary
   */
  async readLocalFile(
    vaultPath: string
  ): Promise<{ buffer: ArrayBuffer; name: string; mimeType: string } | null> {
    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) {
      return null;
    }

    const buffer = await this.app.vault.readBinary(file);
    const ext = file.extension.toLowerCase();
    const mimeType = this.getMimeType(ext);

    return {
      buffer,
      name: file.name,
      mimeType,
    };
  }

  /**
   * Download a remote image
   */
  async downloadRemoteImage(
    url: string
  ): Promise<{ buffer: ArrayBuffer; name: string; mimeType: string } | null> {
    try {
      const response = await requestUrl({
        url,
        method: "GET",
      });

      const contentType =
        response.headers["content-type"] || "image/png";
      const ext = this.extFromMime(contentType);
      const urlPath = new URL(url).pathname;
      const urlName = urlPath.split("/").pop() || `image.${ext}`;
      // Ensure the name has an extension
      const name = urlName.includes(".") ? urlName : `${urlName}.${ext}`;

      return {
        buffer: response.arrayBuffer,
        name,
        mimeType: contentType.split(";")[0].trim(),
      };
    } catch (e) {
      console.error(`Failed to download remote image: ${url}`, e);
      return null;
    }
  }

  /**
   * Upload a file to blogman R2 via /api/uploads
   */
  async uploadFile(
    buffer: ArrayBuffer,
    fileName: string,
    mimeType: string
  ): Promise<UploadResult> {
    // Build multipart form data manually for Obsidian's requestUrl
    const boundary = "----ObsidianBlogman" + Date.now().toString(36);
    const uint8 = new Uint8Array(buffer);

    // Build the multipart body
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const headerBytes = new TextEncoder().encode(header);
    const footerBytes = new TextEncoder().encode(footer);

    const body = new Uint8Array(
      headerBytes.length + uint8.length + footerBytes.length
    );
    body.set(headerBytes, 0);
    body.set(uint8, headerBytes.length);
    body.set(footerBytes, headerBytes.length + uint8.length);

    const response = await requestUrl({
      url: `${this.settings.apiUrl}/api/uploads?_t=${Date.now()}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.apiToken}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Cache-Control": "no-cache, no-store",
      },
      body: body.buffer,
    });

    const json = response.json as UploadResult;
    return json;
  }

  /**
   * Create a post via /api/posts
   */
  /**
   * Create or update a post via the B2-08 versioned protocol
   * (protocol=v1: identity + expected version + operation id + full snapshot).
   *
   * - creation is idempotent (stable creationId per note path) so network
   *   retries never duplicate the article;
   * - updates go through `save` with the stored expected version and an
   *   operation id derived from the content hash (same content retries replay);
   * - draft<->published transitions go through `publishTemp` only.
   */
  async createPost(
    file: TFile,
    title: string,
    content: string,
    status: "draft" | "published" = "draft",
    category: string = "",
    description: string = ""
  ): Promise<PostResult> {
    const notePath = file.path;
    const creationId = `obsidian:${encodeURIComponent(notePath)}`;
    const prior = this.publishState[notePath] ?? null;

    const snapshot: Record<string, unknown> = { title, content, status: "draft" };
    if (category) snapshot.category = category;
    if (description) snapshot.description = description;

    let articleId: number | null = prior?.articleId ?? null;
    let version = prior?.version ?? 0;
    let nextStatus: "draft" | "published" = prior?.status ?? "draft";
    let slug: string | undefined;

    // 1. Create (idempotent) or update (versioned save) the content.
    if (articleId === null) {
      const created = await this.versionedRequest({ action: "create", creationId, snapshot });
      if (!created.ok) return { success: false, error: created.error };
      if (created.json.protocol !== "v1") {
        return {
          success: false,
          error: "目标服务器不支持 versioned 写入协议（protocol=v1），请先升级服务器后再发布",
        };
      }
      articleId = Number(created.json.articleId);
      version = Number(created.json.version);
      slug = typeof created.json.slug === "string" ? created.json.slug : undefined;
    } else {
      const operationId = `obsidian:save:${creationId}:${this.contentHash(content)}`;
      const saved = await this.versionedRequest({
        action: "save",
        articleId,
        expectedVersion: version,
        operationId,
        snapshot,
      });
      if (saved.json.outcome === "conflict" || saved.json.outcome === "status-conflict") {
        return {
          success: false,
          error: `版本冲突：服务器为 v${saved.json.serverVersion ?? "?"}，本地为 v${version}。请在网页端刷新后重试`,
        };
      }
      if (!saved.ok) return { success: false, error: saved.error };
      version = Number(saved.json.version);
      slug = typeof saved.json.slug === "string" ? saved.json.slug : undefined;
    }

    // 2. Status transition only via the versioned publish path.
    if (articleId === null) {
      return { success: false, error: "创建失败：未取得文章编号" };
    }
    if (status === "published" && nextStatus !== "published") {
      const pub = await this.versionedRequest({
        action: "publishTemp",
        articleId,
        expectedVersion: version,
        currentStatus: "draft",
        operationId: `obsidian:pub:${creationId}:${version}`,
        status: "published",
      });
      if (pub.json.outcome === "conflict" || pub.json.outcome === "status-conflict") {
        return { success: false, error: "发布冲突：文章状态已在别处变更，请在网页端刷新后重试" };
      }
      if (!pub.ok) return { success: false, error: pub.error };
      version = Number(pub.json.version);
      nextStatus = "published";
    } else if (status === "draft" && nextStatus === "published") {
      const unpub = await this.versionedRequest({
        action: "publishTemp",
        articleId,
        expectedVersion: version,
        currentStatus: "published",
        operationId: `obsidian:unpub:${creationId}:${version}`,
        status: "draft",
      });
      if (unpub.json.outcome === "conflict" || unpub.json.outcome === "status-conflict") {
        return { success: false, error: "取消发布冲突：文章状态已在别处变更，请在网页端刷新后重试" };
      }
      if (!unpub.ok) return { success: false, error: unpub.error };
      version = Number(unpub.json.version);
      nextStatus = "draft";
    }

    // 3. Persist the per-note state so the next publish updates by version.
    this.publishState[notePath] = { articleId, version, status: nextStatus };
    await this.saveSettings();
    return { success: true, slug, articleId, version };
  }

  /**
   * POST one versioned action to /api/posts and normalize the response.
   */
  private async versionedRequest(payload: Record<string, unknown>): Promise<{
    ok: boolean;
    status: number;
    json: Record<string, unknown>;
    error?: string;
  }> {
    try {
      const response = await requestUrl({
        url: `${this.settings.apiUrl}/api/posts?_t=${Date.now()}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.apiToken}`,
          "Content-Type": "application/json",
          "Cache-Control": "no-cache, no-store",
        },
        body: JSON.stringify({ protocol: "v1", ...payload }),
      });
      const json = response.json as Record<string, unknown>;
      const ok = response.status >= 200 && response.status < 300 && json.error === undefined;
      return {
        ok,
        status: response.status,
        json,
        error: typeof json.error === "string" ? json.error : undefined,
      };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        json: {},
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** Deterministic 32-bit content hash (stable operation id across retries). */
  private contentHash(input: string): string {
    let h1 = 0xdeadbeef ^ input.length;
    let h2 = 0x41c6ce57 ^ input.length;
    for (let i = 0; i < input.length; i++) {
      const ch = input.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    return `${input.length}:${(h1 >>> 0).toString(16).padStart(8, "0")}`;
  }

  /**
   * Convert a relative API URL to absolute
   */
  toAbsoluteUrl(url: string): string {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url;
    }
    return `${this.settings.apiUrl}${url.startsWith("/") ? "" : "/"}${url}`;
  }

  /**
   * Get MIME type from file extension
   */
  getMimeType(ext: string): string {
    const map: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      bmp: "image/bmp",
      ico: "image/x-icon",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      m4a: "audio/mp4",
      flac: "audio/flac",
      aac: "audio/aac",
      mp4: "video/mp4",
      webm: "video/webm",
      mov: "video/quicktime",
      avi: "video/x-msvideo",
      mkv: "video/x-matroska",
    };
    return map[ext] || "application/octet-stream";
  }

  /**
   * Get file extension from MIME type
   */
  extFromMime(mime: string): string {
    const clean = mime.split(";")[0].trim().toLowerCase();
    const map: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/svg+xml": "svg",
      "image/bmp": "bmp",
    };
    return map[clean] || "png";
  }
}
