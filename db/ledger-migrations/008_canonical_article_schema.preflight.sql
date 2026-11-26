-- Accept absent objects or objects whose stored SQL matches 008 exactly.
WITH expected_objects(type, name, sql) AS (
  VALUES
    ('table', 'activity_notifications', 'CREATE TABLE activity_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notification_id TEXT UNIQUE NOT NULL CHECK(length(notification_id) > 0),
      source_type TEXT NOT NULL CHECK(length(source_type) > 0),
      source_id TEXT NOT NULL CHECK(length(source_id) > 0),
      title TEXT NOT NULL CHECK(length(title) > 0),
      detail TEXT,
      status TEXT NOT NULL CHECK(status IN (''open'', ''resolved'')),
      acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(source_type, source_id)
    ) STRICT'),
    ('table', 'article_lifecycles', 'CREATE TABLE article_lifecycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT UNIQUE NOT NULL CHECK(length(operation_id) > 0),
      article_id INTEGER NOT NULL,
      post_ref INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      direction TEXT NOT NULL CHECK(direction IN (''unpublish'', ''relive-formal'', ''relive-revision'')),
      lifecycle_before TEXT NOT NULL CHECK(lifecycle_before IN (''published'', ''unpublished'')),
      lifecycle_after TEXT NOT NULL CHECK(lifecycle_after IN (''published'', ''unpublished'')),
      source_version INTEGER,
      public_url TEXT,
      evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
      payload TEXT NOT NULL,
      actor TEXT NOT NULL CHECK(length(actor) > 0),
      created_at INTEGER NOT NULL
    ) STRICT'),
    ('table', 'article_slug_addresses', 'CREATE TABLE article_slug_addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE CHECK(length(slug) > 0),
      article_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN (''current'', ''candidate'', ''historical'')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT'),
    ('table', 'article_source_links', 'CREATE TABLE article_source_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_identity_id INTEGER NOT NULL,
    article_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN (''pending'', ''confirmed'', ''cancelled'')),
    operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) > 0),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  , role TEXT NOT NULL DEFAULT ''clip'') STRICT'),
    ('table', 'article_versions', 'CREATE TABLE article_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      operation_id TEXT NOT NULL UNIQUE,
      snapshot_json TEXT NOT NULL,
      content_snapshot_sha256 TEXT NOT NULL,
      published_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime(''%s'', ''now'')),
      UNIQUE (article_id, version)
    )'),
    ('table', 'articles', 'CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_ref INTEGER UNIQUE NOT NULL,
      slug TEXT,
      draft_ref TEXT,
      source_page_identity TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime(''%s'', ''now''))
    )'),
    ('table', 'email_deliveries', 'CREATE TABLE email_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL CHECK(length(source_type) > 0),
    source_id TEXT NOT NULL CHECK(length(source_id) > 0),
    last_attempt_at INTEGER,
    last_sent_at INTEGER,
    sent_count INTEGER NOT NULL DEFAULT 0 CHECK(sent_count >= 0),
    last_status TEXT NOT NULL DEFAULT ''skipped'' CHECK(last_status IN (''skipped'', ''sent'', ''failed'')),
    last_error TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE(source_type, source_id)
  ) STRICT'),
    ('table', 'email_reminder_config', 'CREATE TABLE email_reminder_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL CHECK(length(key) > 0),
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    recipients_json TEXT NOT NULL,
    from_address TEXT,
    threshold_seconds INTEGER NOT NULL DEFAULT 0 CHECK(threshold_seconds >= 0),
    quiet_start_minute INTEGER NOT NULL DEFAULT 0 CHECK(quiet_start_minute BETWEEN 0 AND 1439),
    quiet_end_minute INTEGER NOT NULL DEFAULT 0 CHECK(quiet_end_minute BETWEEN 0 AND 1439),
    utc_offset_minutes INTEGER NOT NULL DEFAULT 0,
    cooldown_seconds INTEGER NOT NULL DEFAULT 0 CHECK(cooldown_seconds >= 0),
    updated_at INTEGER NOT NULL
  ) STRICT'),
    ('table', 'formal_publications', 'CREATE TABLE formal_publications (
      article_id INTEGER PRIMARY KEY,
      version INTEGER NOT NULL CHECK(version > 0),
      slug TEXT NOT NULL UNIQUE CHECK(length(slug) > 0),
      lifecycle TEXT NOT NULL CHECK(lifecycle IN (''published'', ''unpublished'')),
      first_published_at INTEGER NOT NULL,
      published_at INTEGER NOT NULL,
      public_url TEXT NOT NULL CHECK(length(public_url) > 0),
      event_id TEXT NOT NULL CHECK(length(event_id) > 0)
    ) STRICT'),
    ('table', 'media_assets', 'CREATE TABLE media_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_sha256 TEXT NOT NULL UNIQUE CHECK(length(content_sha256) = 64),
    r2_key TEXT NOT NULL UNIQUE CHECK(length(r2_key) > 0),
    media_type TEXT NOT NULL CHECK(length(media_type) > 0),
    filename TEXT,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT'),
    ('table', 'publish_attempts', 'CREATE TABLE publish_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_key TEXT UNIQUE NOT NULL CHECK(length(attempt_key) > 0),
      schedule_id TEXT NOT NULL CHECK(length(schedule_id) > 0),
      attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
      started_at INTEGER NOT NULL CHECK(started_at > 0),
      finished_at INTEGER,
      outcome TEXT CHECK(outcome IN (''fired'', ''stale'', ''retried'', ''failed'', ''abandoned'', ''cancelled'')),
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(schedule_id, attempt_no)
    ) STRICT'),
    ('table', 'publish_events', 'CREATE TABLE publish_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL CHECK(length(event_id) > 0),
      intent_id TEXT UNIQUE NOT NULL CHECK(length(intent_id) > 0),
      article_id INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      slug TEXT NOT NULL CHECK(length(slug) > 0),
      lifecycle TEXT NOT NULL CHECK(lifecycle IN (''draft'', ''prepared'', ''published'', ''unpublished'', ''deleted'')),
      first_published_at INTEGER NOT NULL,
      evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT'),
    ('table', 'publish_intents', 'CREATE TABLE publish_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      intent_id TEXT UNIQUE NOT NULL CHECK(length(intent_id) > 0),
      prepare_id TEXT UNIQUE NOT NULL CHECK(length(prepare_id) > 0),
      article_id INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      slug TEXT NOT NULL CHECK(length(slug) > 0),
      lifecycle TEXT NOT NULL CHECK(lifecycle IN (''draft'', ''prepared'', ''published'', ''unpublished'', ''deleted'')),
      status TEXT NOT NULL CHECK(status IN (''pending'', ''delivered'', ''failed'')),
      created_at INTEGER NOT NULL
    ) STRICT'),
    ('table', 'publish_outbox', 'CREATE TABLE publish_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outbox_id TEXT UNIQUE NOT NULL CHECK(length(outbox_id) > 0),
      event_id TEXT UNIQUE NOT NULL CHECK(length(event_id) > 0),
      article_id INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      kind TEXT NOT NULL CHECK(kind IN (''public-receipt'', ''index-invalidate'', ''notify'')),
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (''pending'', ''delivered'', ''failed'')),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER
    ) STRICT'),
    ('table', 'publish_preparations', 'CREATE TABLE publish_preparations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      preparation_id TEXT UNIQUE NOT NULL CHECK(length(preparation_id) > 0),
      article_id INTEGER NOT NULL,
      post_ref INTEGER NOT NULL,
      bound_version INTEGER NOT NULL CHECK(bound_version > 0),
      bound_revision TEXT,
      source TEXT NOT NULL CHECK(length(source) > 0),
      status TEXT NOT NULL CHECK(status IN (''recorded'', ''applied'', ''abandoned'')),
      restore_point_id TEXT,
      created_at INTEGER NOT NULL,
      applied_at INTEGER,
      updated_at INTEGER NOT NULL
    ) STRICT'),
    ('table', 'publish_prepares', 'CREATE TABLE publish_prepares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prepare_id TEXT UNIQUE NOT NULL CHECK(length(prepare_id) > 0),
      article_id INTEGER NOT NULL,
      post_ref INTEGER NOT NULL,
      prepared_version INTEGER NOT NULL CHECK(prepared_version > 0),
      prepared_slug TEXT NOT NULL CHECK(length(prepared_slug) > 0),
      prepared_title TEXT NOT NULL,
      prepared_content_sha256 TEXT NOT NULL CHECK(prepared_content_sha256 = '''' OR length(prepared_content_sha256) = 64),
      blocker_saved INTEGER NOT NULL CHECK(blocker_saved IN (0, 1)),
      blocker_lifecycle INTEGER NOT NULL CHECK(blocker_lifecycle IN (0, 1)),
      blocker_slug INTEGER NOT NULL CHECK(blocker_slug IN (0, 1)),
      blocker_content INTEGER NOT NULL CHECK(blocker_content IN (0, 1)),
      status TEXT NOT NULL CHECK(status IN (''prepared'', ''committed'', ''aborted'', ''superseded'')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT'),
    ('table', 'publish_promotions', 'CREATE TABLE publish_promotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      promotion_id TEXT UNIQUE NOT NULL CHECK(length(promotion_id) > 0),
      article_id INTEGER NOT NULL,
      revision_id TEXT NOT NULL CHECK(length(revision_id) > 0),
      base_version INTEGER NOT NULL CHECK(base_version > 0),
      promoted_version INTEGER NOT NULL CHECK(promoted_version > 0),
      slug TEXT NOT NULL CHECK(length(slug) > 0),
      public_url TEXT NOT NULL CHECK(length(public_url) > 0),
      content_sha256 TEXT NOT NULL CHECK(content_sha256 = '''' OR length(content_sha256) = 64),
      evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
      payload TEXT NOT NULL,
      actor TEXT NOT NULL CHECK(length(actor) > 0),
      created_at INTEGER NOT NULL
    ) STRICT'),
    ('table', 'publish_receipts', 'CREATE TABLE publish_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL CHECK(length(event_id) > 0),
      article_id INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      slug TEXT NOT NULL,
      public_url TEXT NOT NULL,
      receipt_payload TEXT NOT NULL,
      verified INTEGER NOT NULL CHECK(verified IN (0, 1)),
      verified_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT'),
    ('table', 'publish_restore_ops', 'CREATE TABLE publish_restore_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restore_operation_id TEXT UNIQUE NOT NULL CHECK(length(restore_operation_id) > 0),
      article_id INTEGER NOT NULL,
      source_restore_point_id TEXT NOT NULL CHECK(length(source_restore_point_id) > 0),
      target TEXT NOT NULL CHECK(target IN (''revision'', ''draft'')),
      expected_version INTEGER NOT NULL CHECK(expected_version > 0),
      pre_restore_snapshot_json TEXT NOT NULL,
      pre_restore_content_sha256 TEXT NOT NULL,
      revision_id TEXT,
      draft_article_id INTEGER,
      post_ref INTEGER,
      actor TEXT NOT NULL CHECK(length(actor) > 0),
      status TEXT NOT NULL CHECK(status IN (''active'', ''undone'')),
      created_at INTEGER NOT NULL,
      undone_at INTEGER
    ) STRICT'),
    ('table', 'publish_restore_points', 'CREATE TABLE publish_restore_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restore_point_id TEXT UNIQUE NOT NULL CHECK(length(restore_point_id) > 0),
      article_id INTEGER NOT NULL,
      formal_version INTEGER NOT NULL CHECK(formal_version > 0),
      promoted_version INTEGER NOT NULL CHECK(promoted_version > 0),
      snapshot_json TEXT NOT NULL,
      content_sha256 TEXT NOT NULL CHECK(content_sha256 = '''' OR length(content_sha256) = 64),
      reason TEXT NOT NULL CHECK(length(reason) > 0),
      created_at INTEGER NOT NULL
    ) STRICT'),
    ('table', 'publish_revisions', 'CREATE TABLE publish_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision_id TEXT UNIQUE NOT NULL CHECK(length(revision_id) > 0),
      article_id INTEGER NOT NULL,
      base_version INTEGER NOT NULL CHECK(base_version > 0),
      revision_number INTEGER NOT NULL CHECK(revision_number > 0),
      status TEXT NOT NULL CHECK(status IN (''active'', ''promoted'', ''discarded'')),
      slug TEXT NOT NULL CHECK(length(slug) > 0),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      html TEXT NOT NULL,
      description TEXT,
      category TEXT,
      tags TEXT,
      password TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
      is_hidden INTEGER NOT NULL DEFAULT 0 CHECK(is_hidden IN (0, 1)),
      cover_image TEXT,
      content_sha256 TEXT NOT NULL CHECK(content_sha256 = '''' OR length(content_sha256) = 64),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT'),
    ('table', 'publish_schedules', 'CREATE TABLE publish_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT UNIQUE NOT NULL CHECK(length(schedule_id) > 0),
      article_id INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      scheduled_at INTEGER NOT NULL CHECK(scheduled_at > 0),
      timezone TEXT NOT NULL CHECK(length(timezone) > 0),
      status TEXT NOT NULL CHECK(status IN (''pending'', ''claimed'', ''fired'', ''stale'', ''cancelled'')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      claimed_at INTEGER,
      lease_expires_at INTEGER,
      lease_token TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      stale_reason TEXT,
      fired_event_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT'),
    ('table', 'publish_suggestions', 'CREATE TABLE publish_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      suggestion_id TEXT UNIQUE NOT NULL CHECK(length(suggestion_id) > 0),
      preparation_id TEXT NOT NULL CHECK(length(preparation_id) > 0),
      article_id INTEGER NOT NULL,
      field TEXT NOT NULL CHECK(field IN (''category'', ''tags'', ''description'', ''title'', ''content'')),
      value TEXT NOT NULL,
      field_before TEXT,
      basis_sha256 TEXT NOT NULL CHECK(length(basis_sha256) = 64),
      bound_version INTEGER NOT NULL CHECK(bound_version > 0),
      status TEXT NOT NULL CHECK(status IN (''pending'', ''applied'', ''ignored'', ''revoked'', ''stale'', ''abandoned'')),
      applied_operation_id TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      updated_at INTEGER NOT NULL
    ) STRICT'),
    ('table', 'schedule_control_ops', 'CREATE TABLE schedule_control_ops (id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT UNIQUE NOT NULL CHECK(length(operation_id) > 0), schedule_id TEXT NOT NULL CHECK(length(schedule_id) > 0), action TEXT NOT NULL CHECK(action IN (''pause'',''reconfirm'',''reschedule'',''cancel'',''publish_now'')), result TEXT NOT NULL CHECK(length(result) > 0), created_at INTEGER NOT NULL) STRICT'),
    ('table', 'source_availability_observations', 'CREATE TABLE source_availability_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_identity_id INTEGER NOT NULL CHECK(source_identity_id > 0),
    operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) > 0),
    outcome TEXT NOT NULL CHECK(outcome IN (''readable'', ''temporarily-unavailable'', ''confirmed-missing'')),
    detail TEXT,
    observed_at INTEGER NOT NULL
  ) STRICT'),
    ('table', 'source_baseline_facts', 'CREATE TABLE source_baseline_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_identity_id INTEGER NOT NULL UNIQUE CHECK(source_identity_id > 0),
    content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
    advanced_by_operation_id TEXT NOT NULL CHECK(length(advanced_by_operation_id) > 0),
    advanced_at INTEGER NOT NULL
  ) STRICT'),
    ('table', 'source_conflict_resolutions', 'CREATE TABLE source_conflict_resolutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) > 0),
  source_identity_id INTEGER NOT NULL,
  article_id INTEGER NOT NULL,
  chosen_side TEXT NOT NULL CHECK(chosen_side IN (''source'', ''blogman'')),
  baseline_version INTEGER NOT NULL,
  baseline_sha256 TEXT NOT NULL CHECK(length(baseline_sha256) = 64),
  anchored_source_sha256 TEXT NOT NULL CHECK(length(anchored_source_sha256) = 64),
  anchored_article_version INTEGER NOT NULL,
  source_projection_json TEXT NOT NULL,
  source_media_json TEXT NOT NULL,
  pre_resolution_snapshot_json TEXT NOT NULL,
  write_back_content_json TEXT,
  status TEXT NOT NULL CHECK(status IN (''open'', ''applied'', ''expired'')),
  created_at INTEGER NOT NULL,
  applied_at INTEGER
) STRICT'),
    ('table', 'source_identities', 'CREATE TABLE source_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_url TEXT NOT NULL UNIQUE CHECK(length(canonical_url) > 0),
    identity_sha256 TEXT NOT NULL UNIQUE CHECK(length(identity_sha256) = 64),
    created_at INTEGER NOT NULL
  ) STRICT'),
    ('table', 'source_media_mappings', 'CREATE TABLE source_media_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_identity_id INTEGER NOT NULL,
    source_ref TEXT NOT NULL CHECK(length(source_ref) > 0),
    media_asset_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(source_identity_id, source_ref)
  ) STRICT'),
    ('table', 'source_refresh_proposals', 'CREATE TABLE source_refresh_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) > 0),
    source_identity_id INTEGER NOT NULL,
    article_id INTEGER NOT NULL,
    post_ref INTEGER,
    role TEXT NOT NULL DEFAULT ''clip'' CHECK(role = ''clip''),
    proposed_version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT ''proposed''
      CHECK(status IN (''proposed'', ''no-diff'', ''confirmed'', ''cancelled'', ''stale'')),
    source_title TEXT NOT NULL,
    source_markdown TEXT NOT NULL,
    source_html TEXT NOT NULL,
    snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256) = 64),
    diff_json TEXT NOT NULL,
    media_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT'),
    ('table', 'source_refresh_records', 'CREATE TABLE source_refresh_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) > 0),
    proposal_operation_id TEXT NOT NULL CHECK(length(proposal_operation_id) > 0),
    source_identity_id INTEGER NOT NULL,
    article_id INTEGER NOT NULL,
    post_ref INTEGER,
    role TEXT NOT NULL DEFAULT ''clip'' CHECK(role = ''clip''),
    outcome TEXT NOT NULL CHECK(outcome IN (''refreshed'', ''failed'')),
    reason TEXT,
    expected_version INTEGER NOT NULL,
    applied_version INTEGER,
    applied_revision_id TEXT,
    baseline_sha256 TEXT,
    projection_json TEXT,
    media_json TEXT,
    diff_json TEXT,
    created_at INTEGER NOT NULL
  ) STRICT'),
    ('table', 'source_sync_attempts', 'CREATE TABLE source_sync_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) > 0),
    source_identity_id INTEGER NOT NULL,
    article_id INTEGER NOT NULL,
    post_ref INTEGER,
    outcome TEXT NOT NULL CHECK(outcome IN (''synced'', ''failed'')),
    reason TEXT,
    baseline_sha256 TEXT,
    synced_version INTEGER,
    synced_revision_id TEXT,
    projection_json TEXT,
    media_json TEXT,
    created_at INTEGER NOT NULL
  ) STRICT'),
    ('table', 'source_sync_baselines', 'CREATE TABLE source_sync_baselines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_identity_id INTEGER NOT NULL,
  article_id INTEGER NOT NULL,
  article_version INTEGER,
  source_sync_sha256 TEXT CHECK(source_sync_sha256 IS NULL OR length(source_sync_sha256) = 64),
  baseline_sha256 TEXT CHECK(baseline_sha256 IS NULL OR length(baseline_sha256) = 64),
  synced_version INTEGER,
  synced_revision_id TEXT,
  synced_title TEXT,
  synced_markdown TEXT,
  synced_html TEXT,
  synced_media_json TEXT DEFAULT ''[]'',
  created_at INTEGER NOT NULL DEFAULT (strftime(''%s'', ''now'')),
  updated_at INTEGER NOT NULL,
  UNIQUE(source_identity_id, article_id)
) STRICT'),
    ('table', 'source_url_variants', 'CREATE TABLE source_url_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_identity_id INTEGER NOT NULL,
    variant_canonical_url TEXT NOT NULL UNIQUE CHECK(length(variant_canonical_url) > 0),
    merged_by_operation_id TEXT NOT NULL UNIQUE CHECK(length(merged_by_operation_id) > 0),
    created_at INTEGER NOT NULL
  ) STRICT'),
    ('table', 'source_write_back_intents', 'CREATE TABLE source_write_back_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_identity_id INTEGER NOT NULL,
  article_id INTEGER NOT NULL,
  article_version INTEGER NOT NULL,
  baseline_version INTEGER NOT NULL,
  operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) > 0),
  status TEXT NOT NULL CHECK(status IN (''intent'', ''written'', ''confirmed'', ''stale'')),
  external_ref TEXT,
  source_sync_sha256 TEXT CHECK(source_sync_sha256 IS NULL OR length(source_sync_sha256) = 64),
  intent_at INTEGER NOT NULL,
  written_at INTEGER,
  confirmed_at INTEGER
) STRICT'),
    ('table', 'wechat_draft_attempts', 'CREATE TABLE wechat_draft_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_key TEXT UNIQUE NOT NULL CHECK(length(attempt_key) > 0),
    task_id TEXT NOT NULL CHECK(length(task_id) > 0),
    attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
    classification TEXT NOT NULL CHECK(
      classification IN (''ok'', ''retryable'', ''needs-author'', ''unknown'')
    ),
    outcome TEXT NOT NULL CHECK(
      outcome IN (''submitted'', ''retried'', ''failed'', ''unknown'', ''reconciled'', ''abandoned'', ''cancelled'')
    ),
    started_at INTEGER NOT NULL CHECK(started_at > 0),
    finished_at INTEGER,
    remote_draft_id TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT'),
    ('table', 'wechat_draft_generations', 'CREATE TABLE wechat_draft_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL CHECK(article_id > 0),
    account_id TEXT NOT NULL CHECK(length(account_id) > 0),
    generation INTEGER NOT NULL CHECK(generation > 0),
    version INTEGER NOT NULL CHECK(version > 0),
    task_id TEXT NOT NULL CHECK(length(task_id) > 0),
    replaces_task_id TEXT,
    status TEXT NOT NULL CHECK(status IN (''draft'', ''submitted'', ''failed'', ''superseded'')),
    settings_revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (article_id, account_id, generation),
    UNIQUE (task_id)
  ) STRICT'),
    ('table', 'wechat_draft_replacements', 'CREATE TABLE wechat_draft_replacements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    replacement_key TEXT UNIQUE NOT NULL CHECK(length(replacement_key) > 0),
    article_id INTEGER NOT NULL CHECK(article_id > 0),
    version INTEGER NOT NULL CHECK(version > 0),
    account_id TEXT NOT NULL CHECK(length(account_id) > 0),
    replaces_task_id TEXT NOT NULL CHECK(length(replaces_task_id) > 0),
    generation INTEGER NOT NULL CHECK(generation > 0),
    status TEXT NOT NULL CHECK(status IN (''draft'', ''submitted'', ''failed'', ''superseded'')),
    title TEXT NOT NULL,
    html_projection TEXT NOT NULL,
    plaintext_projection TEXT NOT NULL,
    cover_image_url TEXT,
    digest TEXT,
    content_sha256 TEXT NOT NULL CHECK(content_sha256 = '''' OR length(content_sha256) = 64),
    projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256) = 64),
    source_url TEXT NOT NULL CHECK(length(source_url) > 0),
    remote_draft_id TEXT,
    provider_error TEXT,
    settings_revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    classification TEXT,
    needs_author INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    last_error TEXT,
    claimed_at INTEGER,
    lease_token TEXT,
    lease_expires_at INTEGER
  ) STRICT'),
    ('table', 'wechat_draft_settings', 'CREATE TABLE wechat_draft_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL CHECK(article_id > 0),
    account_id TEXT NOT NULL CHECK(length(account_id) > 0),
    settings_revision INTEGER NOT NULL CHECK(settings_revision > 0),
    title_override TEXT,
    digest_override TEXT,
    cover_image_override TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (article_id, account_id)
  ) STRICT'),
    ('table', 'wechat_draft_tasks', 'CREATE TABLE wechat_draft_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT UNIQUE NOT NULL CHECK(length(task_id) > 0),
      article_id INTEGER NOT NULL CHECK(article_id > 0),
      post_ref INTEGER NOT NULL CHECK(post_ref > 0),
      version INTEGER NOT NULL CHECK(version > 0),
      account_id TEXT NOT NULL CHECK(length(account_id) > 0),
      status TEXT NOT NULL CHECK(status IN (''draft'', ''submitted'', ''failed'', ''superseded'')),
      title TEXT NOT NULL,
      html_projection TEXT NOT NULL,
      plaintext_projection TEXT NOT NULL,
      cover_image_url TEXT,
      digest TEXT,
      content_sha256 TEXT NOT NULL CHECK(content_sha256 = '''' OR length(content_sha256) = 64),
      projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256) = 64),
      source_url TEXT NOT NULL CHECK(length(source_url) > 0),
      remote_draft_id TEXT,
      provider_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (article_id, version, account_id)
    ) STRICT'),
    ('table', 'workbench_controls', 'CREATE TABLE workbench_controls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL CHECK(length(key) > 0),
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      updated_at INTEGER NOT NULL
    ) STRICT'),
    ('table', 'article_fts', 'CREATE VIRTUAL TABLE article_fts USING fts5(title, content)'),
    ('index', 'idx_activity_notifications_source', 'CREATE INDEX idx_activity_notifications_source
    ON activity_notifications(source_type, source_id)'),
    ('index', 'idx_article_lifecycles_article', 'CREATE INDEX idx_article_lifecycles_article
      ON article_lifecycles(article_id, version)'),
    ('index', 'idx_article_slug_article', 'CREATE INDEX idx_article_slug_article
     ON article_slug_addresses(article_id, kind)'),
    ('index', 'idx_article_slug_current', 'CREATE UNIQUE INDEX idx_article_slug_current
     ON article_slug_addresses(article_id) WHERE kind = ''current'''),
    ('index', 'idx_article_source_article', 'CREATE INDEX idx_article_source_article
     ON article_source_links(article_id, status)'),
    ('index', 'idx_article_source_identity', 'CREATE INDEX idx_article_source_identity
     ON article_source_links(source_identity_id, status)'),
    ('index', 'idx_article_source_live', 'CREATE UNIQUE INDEX idx_article_source_live
     ON article_source_links(source_identity_id) WHERE status != ''cancelled'''),
    ('index', 'idx_conflict_resolutions_article', 'CREATE INDEX idx_conflict_resolutions_article
     ON source_conflict_resolutions(article_id, status)'),
    ('index', 'idx_conflict_resolutions_identity', 'CREATE INDEX idx_conflict_resolutions_identity
     ON source_conflict_resolutions(source_identity_id, status)'),
    ('index', 'idx_publish_attempts_schedule', 'CREATE INDEX idx_publish_attempts_schedule
      ON publish_attempts(schedule_id, attempt_no)'),
    ('index', 'idx_publish_preparations_article', 'CREATE INDEX idx_publish_preparations_article
      ON publish_preparations(article_id, status)'),
    ('index', 'idx_publish_promotions_article', 'CREATE UNIQUE INDEX idx_publish_promotions_article
      ON publish_promotions(article_id, promoted_version)'),
    ('index', 'idx_publish_restore_ops_article', 'CREATE INDEX idx_publish_restore_ops_article
      ON publish_restore_ops(article_id)'),
    ('index', 'idx_publish_revisions_active', 'CREATE UNIQUE INDEX idx_publish_revisions_active
      ON publish_revisions(article_id) WHERE status = ''active'''),
    ('index', 'idx_publish_schedules_due', 'CREATE INDEX idx_publish_schedules_due
      ON publish_schedules(status, scheduled_at)'),
    ('index', 'idx_publish_suggestions_article', 'CREATE INDEX idx_publish_suggestions_article
      ON publish_suggestions(article_id, status)'),
    ('index', 'idx_publish_suggestions_prep', 'CREATE INDEX idx_publish_suggestions_prep
      ON publish_suggestions(preparation_id)'),
    ('index', 'idx_source_avail_identity', 'CREATE INDEX idx_source_avail_identity
     ON source_availability_observations(source_identity_id, observed_at)'),
    ('index', 'idx_source_media_map_asset', 'CREATE INDEX idx_source_media_map_asset
     ON source_media_mappings(media_asset_id)'),
    ('index', 'idx_source_refresh_proposals_article', 'CREATE INDEX idx_source_refresh_proposals_article
     ON source_refresh_proposals(article_id)'),
    ('index', 'idx_source_refresh_records_article', 'CREATE INDEX idx_source_refresh_records_article
     ON source_refresh_records(article_id)'),
    ('index', 'idx_source_sync_attempts_article', 'CREATE INDEX idx_source_sync_attempts_article
     ON source_sync_attempts(article_id)'),
    ('index', 'idx_source_sync_baselines_article', 'CREATE INDEX idx_source_sync_baselines_article
     ON source_sync_baselines(article_id)'),
    ('index', 'idx_source_url_variants_identity', 'CREATE INDEX idx_source_url_variants_identity
     ON source_url_variants(source_identity_id)'),
    ('index', 'idx_wechat_draft_attempts_task', 'CREATE INDEX idx_wechat_draft_attempts_task
     ON wechat_draft_attempts(task_id, id)'),
    ('index', 'idx_wechat_draft_generations_group', 'CREATE INDEX idx_wechat_draft_generations_group
     ON wechat_draft_generations(article_id, account_id, generation)'),
    ('index', 'idx_wechat_draft_replacements_group', 'CREATE INDEX idx_wechat_draft_replacements_group
     ON wechat_draft_replacements(article_id, account_id, version)'),
    ('index', 'idx_wechat_draft_replacements_status', 'CREATE INDEX idx_wechat_draft_replacements_status
     ON wechat_draft_replacements(status, next_attempt_at)'),
    ('index', 'idx_wechat_draft_settings_article', 'CREATE INDEX idx_wechat_draft_settings_article
     ON wechat_draft_settings(article_id, account_id)'),
    ('index', 'idx_wechat_draft_tasks_article', 'CREATE INDEX idx_wechat_draft_tasks_article
      ON wechat_draft_tasks(article_id, account_id, version)'),
    ('index', 'idx_write_back_intents_article', 'CREATE INDEX idx_write_back_intents_article
     ON source_write_back_intents(article_id, status)'),
    ('index', 'idx_write_back_intents_identity', 'CREATE INDEX idx_write_back_intents_identity
     ON source_write_back_intents(source_identity_id, status)'),
    ('trigger', 'article_fts_version_indexed', 'CREATE TRIGGER article_fts_version_indexed
     AFTER INSERT ON article_versions
   BEGIN
     DELETE FROM article_fts WHERE rowid = new.article_id;
     INSERT INTO article_fts(rowid, title, content)
     VALUES (
       new.article_id,
       COALESCE(json_extract(new.snapshot_json, ''$.fields.title''), ''''),
       COALESCE(json_extract(new.snapshot_json, ''$.original_content''), '''')
     );
   END')
)
SELECT 'schema drift ' || expected_objects.type || ' ' || expected_objects.name AS issue
FROM expected_objects
JOIN sqlite_schema
  ON sqlite_schema.name = expected_objects.name
WHERE sqlite_schema.type <> expected_objects.type
   OR sqlite_schema.sql IS NOT expected_objects.sql
ORDER BY issue;
