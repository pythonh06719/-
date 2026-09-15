-- =============================================================================
-- 「轻生活」数据库 DDL —— SQLite 方言（MVP 默认，可直接执行）
-- 执行： sqlite3 qingshenghuo.db < docs/SCHEMA.sql
-- 生产： 见 docs/schema.pg.sql（PostgreSQL 16）
-- 约定： 布尔=INTEGER(0/1) | JSON=TEXT | 日期=TEXT 'YYYY-MM-DD'(本地时区)
--        时间戳=TEXT ISO8601 UTC(含毫秒) | 枚举=TEXT + CHECK | 单位 kcal/g/ml/kg/cm
-- 硬删除：全部业务表 FOREIGN KEY ... ON DELETE CASCADE（PRD R10.4 / TC-41）
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- 1. users —— 身份与鉴权（纯鉴权表，敏感资料见 user_profiles）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT    NOT NULL,
  password_hash      TEXT,                                  -- bcryptjs cost=12；纯验证码用户为 NULL (D9)
  email_verified_at  TEXT,                                  -- ISO8601 UTC
  status             TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users(email);

-- -----------------------------------------------------------------------------
-- 2. auth_verification_codes —— 邮箱验证码（存 hash、一次性、5 分钟过期）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_verification_codes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT    NOT NULL,
  code_hash    TEXT    NOT NULL,                             -- 仅存 hash，不存明文
  purpose      TEXT    NOT NULL DEFAULT 'login' CHECK (purpose IN ('login','signup','reset')),
  expires_at   TEXT    NOT NULL,                             -- ISO8601 UTC
  consumed_at  TEXT,                                         -- 消费即置位（一次性）
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_avc_email_purpose ON auth_verification_codes(email, purpose, expires_at);

-- -----------------------------------------------------------------------------
-- 3. user_profiles —— 基础资料（1:1 users）
--    conditions 为敏感字段：应用层按 D3 做访问控制/导出可选排除（PRD Q12）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id                INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  gender                 TEXT    NOT NULL CHECK (gender IN ('male','female')),
  birth_date             TEXT    NOT NULL,                   -- 'YYYY-MM-DD'，用于算 age(14-100)
  height_cm              REAL    NOT NULL CHECK (height_cm > 0),
  activity_level         TEXT    NOT NULL CHECK (activity_level IN ('sedentary','light','moderate','high','athlete')),
  dietary_preference     TEXT    NOT NULL DEFAULT '[]',      -- JSON array<string>
  conditions             TEXT    NOT NULL DEFAULT '[]',      -- JSON array<string>（敏感，D3）
  disclaimer_accepted_at TEXT,                                -- 免责声明确认时间 (US-04/R1.5)
  onboarding_completed_at TEXT,
  created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- -----------------------------------------------------------------------------
-- 4. user_goals —— 当前生效目标（1:1 users）；修改即重算 (R1.4)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_goals (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  start_weight_kg  REAL    NOT NULL,
  target_weight_kg REAL    NOT NULL CHECK (target_weight_kg > 0),
  target_weeks     INTEGER NOT NULL CHECK (target_weeks > 0),
  weekly_loss_kg   REAL    NOT NULL CHECK (weekly_loss_kg > 0),   -- Q5 推导并落库
  macro_ratio      TEXT    NOT NULL DEFAULT '{"protein":25,"fat":25,"carb":50}',  -- JSON，和须=100
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- -----------------------------------------------------------------------------
-- 5. weight_goal_history —— 目标变更历史（追加式，支撑预测曲线与审计）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS weight_goal_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_weight_kg  REAL    NOT NULL,
  target_weight_kg REAL    NOT NULL,
  target_weeks     INTEGER NOT NULL,
  weekly_loss_kg   REAL    NOT NULL,
  macro_ratio      TEXT    NOT NULL DEFAULT '{"protein":25,"fat":25,"carb":50}',
  effective_from   TEXT    NOT NULL,                          -- 'YYYY-MM-DD' 本地日期
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_wgh_user_from ON weight_goal_history(user_id, effective_from);

-- -----------------------------------------------------------------------------
-- 6. user_settings —— 单位/深色/饮水目标/断食开关（1:1 users）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_settings (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  unit           TEXT    NOT NULL DEFAULT 'kcal' CHECK (unit IN ('kcal','kj')),   -- kcal/kJ 切换 (R2.11)
  dark_mode      INTEGER NOT NULL DEFAULT 0 CHECK (dark_mode IN (0,1)),
  water_goal_ml  INTEGER NOT NULL DEFAULT 2000 CHECK (water_goal_ml > 0),
  fasting_enabled INTEGER NOT NULL DEFAULT 0 CHECK (fasting_enabled IN (0,1)),     -- 默认关闭 (R8.1)
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- -----------------------------------------------------------------------------
-- 7. weight_logs —— 每日体重（同日唯一；CSV 导入 UPSERT 覆盖）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS weight_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  logged_at     TEXT    NOT NULL,                             -- 'YYYY-MM-DD' 本地日期，当日唯一
  weight_kg     REAL    NOT NULL CHECK (weight_kg > 0 AND weight_kg < 500),
  note          TEXT,                                         -- <=200 字
  source        TEXT    NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import')),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_weight_user_day ON weight_logs(user_id, logged_at);
CREATE INDEX IF NOT EXISTS ix_weight_user_at ON weight_logs(user_id, logged_at);   -- 7 日均线

-- -----------------------------------------------------------------------------
-- 8. food_items —— 中式食物库（每 100g 营养 + 自然份量单位）
--    serving_units JSON 结构见 docs/ARCHITECTURE.md §3.3
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS food_items (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT    NOT NULL,
  name_pinyin           TEXT,                                 -- 拼音模糊搜索
  aliases               TEXT    NOT NULL DEFAULT '[]',       -- JSON array<string>
  category              TEXT    NOT NULL DEFAULT 'other',    -- 家常菜/主食/外卖/奶茶/零食/水果/蔬菜/蛋白/other
  kcal_per_100g         REAL    NOT NULL CHECK (kcal_per_100g >= 0),
  protein_g_per_100g    REAL    NOT NULL DEFAULT 0,
  fat_g_per_100g        REAL    NOT NULL DEFAULT 0,
  carb_g_per_100g       REAL    NOT NULL DEFAULT 0,
  -- 微量营养素（二期面板需用量，一期可留空）
  fiber_g_per_100g      REAL,
  sodium_mg_per_100g    REAL,
  saturated_fat_g_per_100g REAL,
  sugar_g_per_100g      REAL,
  calcium_mg_per_100g   REAL,
  iron_mg_per_100g      REAL,
  potassium_mg_per_100g REAL,
  vitamin_d_ug_per_100g REAL,
  b12_ug_per_100g       REAL,
  magnesium_mg_per_100g REAL,
  serving_units         TEXT    NOT NULL DEFAULT '[]',       -- JSON array<{unit,grams,isDefault?,label?}> (R3.3)
  default_serving_grams REAL,
  barcode               TEXT,                                 -- Open Food Facts (二期, R3.6)
  source                TEXT    NOT NULL DEFAULT 'builtin' CHECK (source IN ('builtin','openfoodfacts','user_custom')),
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- user_custom 归属；builtin 为 NULL
  is_verified           INTEGER NOT NULL DEFAULT 0 CHECK (is_verified IN (0,1)),
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_food_name        ON food_items(name);
CREATE INDEX IF NOT EXISTS ix_food_pinyin      ON food_items(name_pinyin);
CREATE INDEX IF NOT EXISTS ix_food_category    ON food_items(category);
CREATE INDEX IF NOT EXISTS ix_food_source      ON food_items(source);
CREATE UNIQUE INDEX IF NOT EXISTS ux_food_barcode
  ON food_items(barcode) WHERE barcode IS NOT NULL;            -- 扫码命中 (TC-03/20)

-- -----------------------------------------------------------------------------
-- 9. food_favorites —— 收藏（R3.4）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS food_favorites (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  food_item_id INTEGER NOT NULL REFERENCES food_items(id) ON DELETE CASCADE,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, food_item_id)
);

-- -----------------------------------------------------------------------------
-- 10. meal_logs —— 饮食记录（search / quick_add / barcode / ai / combo）
--     food_item_id 可为 NULL（快速加卡仅名称+热量，R3.5/TC-19）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meal_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  logged_date   TEXT    NOT NULL,                             -- 'YYYY-MM-DD' 本地日期 (D1)
  meal_type     TEXT    NOT NULL CHECK (meal_type IN ('breakfast','lunch','dinner','snack')),
  food_item_id  INTEGER REFERENCES food_items(id) ON DELETE SET NULL,
  custom_name   TEXT,                                         -- 快速加卡/AI 名称
  grams         REAL,                                         -- 选定克数（可为空=按份量估算）
  serving_unit  TEXT,                                         -- 个/碗/杯/片/袋
  serving_qty   REAL,
  kcal          REAL    NOT NULL CHECK (kcal >= 0),
  protein_g     REAL,                                         -- 快速加卡允许为空 (TC-19)
  fat_g         REAL,
  carb_g        REAL,
  fiber_g       REAL,                                         -- 二期微量
  sodium_mg     REAL,
  source        TEXT    NOT NULL DEFAULT 'search'
                CHECK (source IN ('search','quick_add','barcode','ai','combo')),
  combo_id      INTEGER REFERENCES meal_combos(id) ON DELETE SET NULL,
  note          TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,                   -- 餐间拖拽排序 (TC-27)
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_meal_user_date      ON meal_logs(user_id, logged_date);           -- PRD 要求
CREATE INDEX IF NOT EXISTS ix_meal_user_date_type ON meal_logs(user_id, logged_date, meal_type);
CREATE INDEX IF NOT EXISTS ix_meal_user_food      ON meal_logs(user_id, food_item_id);          -- 「最近吃过」

-- -----------------------------------------------------------------------------
-- 11. meal_combos —— 套餐模板头（模板修改不影响历史，US-10）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meal_combos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  meal_type  TEXT    NOT NULL DEFAULT 'breakfast' CHECK (meal_type IN ('breakfast','lunch','dinner','snack')),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_combo_user_name ON meal_combos(user_id, name);

-- -----------------------------------------------------------------------------
-- 12. meal_combo_items —— 套餐模板明细
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meal_combo_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  combo_id     INTEGER NOT NULL REFERENCES meal_combos(id) ON DELETE CASCADE,
  food_item_id INTEGER REFERENCES food_items(id) ON DELETE SET NULL,
  custom_name  TEXT,
  grams        REAL,
  serving_unit TEXT,
  serving_qty  REAL,
  kcal         REAL    NOT NULL DEFAULT 0 CHECK (kcal >= 0),
  protein_g    REAL,
  fat_g        REAL,
  carb_g       REAL,
  sort_order   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_combo_item_combo ON meal_combo_items(combo_id);

-- -----------------------------------------------------------------------------
-- 13. met_activities —— 运动 MET 表（R6.1，二期）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS met_activities (
  code       TEXT PRIMARY KEY,                                 -- walking / running / ...
  name       TEXT    NOT NULL,
  category   TEXT    NOT NULL DEFAULT 'other',
  intensity  TEXT,                                             -- 慢走/快走 等档位 (Q11)
  met        REAL    NOT NULL CHECK (met > 0),
  is_builtin INTEGER NOT NULL DEFAULT 1 CHECK (is_builtin IN (0,1)),
  source     TEXT,                                             -- 2024 成人活动 MET 汇编
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- -----------------------------------------------------------------------------
-- 14. exercise_logs —— 运动记录（消耗 = MET × kg × h，TC-32，二期）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exercise_logs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  logged_date        TEXT    NOT NULL,                         -- 'YYYY-MM-DD' 本地日期
  activity_code      TEXT    NOT NULL REFERENCES met_activities(code) ON DELETE RESTRICT,
  activity_name      TEXT    NOT NULL,                         -- 冗余快照
  met                REAL    NOT NULL CHECK (met > 0),
  minutes            REAL    NOT NULL CHECK (minutes > 0),
  weight_kg_at_log   REAL    NOT NULL CHECK (weight_kg_at_log > 0),
  kcal_burned        REAL    NOT NULL CHECK (kcal_burned >= 0),
  note               TEXT,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_exercise_user_date ON exercise_logs(user_id, logged_date);

-- -----------------------------------------------------------------------------
-- 15. water_logs —— 饮水（一键 +250ml；撤销 = 删除最新一条，TC-33，二期）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS water_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  logged_date TEXT    NOT NULL,                                -- 'YYYY-MM-DD' 本地日期
  logged_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),  -- 精确时间，用于撤销
  amount_ml   INTEGER NOT NULL CHECK (amount_ml > 0),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_water_user_date ON water_logs(user_id, logged_date, logged_at);

-- -----------------------------------------------------------------------------
-- 16. habit_definitions —— 习惯项（user_id NULL = 系统内置模板，R7.3，二期）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS habit_definitions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,   -- NULL=内置
  code           TEXT    NOT NULL,                                 -- water / early_sleep / steps / no_takeout ...
  name           TEXT    NOT NULL,
  icon           TEXT,
  target_per_day INTEGER NOT NULL DEFAULT 1 CHECK (target_per_day > 0),
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_habit_user_code ON habit_definitions(user_id, code);

-- -----------------------------------------------------------------------------
-- 17. habit_checkins —— 习惯打卡（幂等；断签不惩罚，TC-35，二期）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS habit_checkins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  habit_id    INTEGER NOT NULL REFERENCES habit_definitions(id) ON DELETE CASCADE,
  logged_date TEXT    NOT NULL,                                -- 'YYYY-MM-DD' 本地日期
  done        INTEGER NOT NULL DEFAULT 1 CHECK (done IN (0,1)),
  value       REAL,                                            -- 可选数值（步数等）
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_checkin_user_habit_day ON habit_checkins(user_id, habit_id, logged_date);

-- -----------------------------------------------------------------------------
-- 18. fasting_settings —— 断食设置（默认关闭；开启需内容警告确认，R8.1/R8.2）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fasting_settings (
  user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan               TEXT    NOT NULL DEFAULT '16:8' CHECK (plan IN ('16:8','18:6','custom')),
  target_fast_hours  REAL    NOT NULL DEFAULT 16 CHECK (target_fast_hours > 0),
  eat_window_start   TEXT,                                     -- 'HH:mm'
  enabled            INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  disclaimer_ack_at  TEXT,                                     -- 内容警告确认时间
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- -----------------------------------------------------------------------------
-- 19. fasting_sessions —— 断食会话（不做主动推送，R8.3）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fasting_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan          TEXT    NOT NULL DEFAULT '16:8',
  target_hours  REAL    NOT NULL DEFAULT 16,
  started_at    TEXT    NOT NULL,
  ended_at      TEXT,
  completed     INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1)),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_fasting_user_started ON fasting_sessions(user_id, started_at);

-- -----------------------------------------------------------------------------
-- 20. ai_usage —— AI 每日限额（每账号每日每功能计数，上限 50，R9.4，三期）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_date    TEXT    NOT NULL,                              -- 'YYYY-MM-DD' 本地日期
  feature       TEXT    NOT NULL CHECK (feature IN ('daily_summary','today_plan','free_ask','food_recognize')),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  token_in      INTEGER NOT NULL DEFAULT 0,
  token_out     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_usage_user_day_feature ON ai_usage(user_id, usage_date, feature);

-- =============================================================================
-- updated_at 维护说明（SQLite 无 ON UPDATE）
-- 应用层（Prisma）在每次 UPDATE 时显式写入 updated_at；如需 DB 级兜底，
-- 可为需要的表创建如下触发器（示例：users）：
-- CREATE TRIGGER IF NOT EXISTS trg_users_touch
--   AFTER UPDATE ON users FOR EACH ROW
--   BEGIN
--     UPDATE users SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = OLD.id;
--   END;
-- =============================================================================
