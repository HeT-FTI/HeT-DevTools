/** Domain models shared across the extension. */

/** A detected fcpp project root. */
export interface FcppProject {
  /** Absolute path of the project root (a workspace folder). */
  root: string;
  /** Detection level (see development-plan §1.5). */
  level: ProjectLevel;
  /** Parsed metadata.json, when readable. */
  metadata?: FcppMetadata;
  /** Reason metadata could not be read (JSON syntax etc.). */
  metadataError?: string;
}

export type ProjectLevel = 'full' | 'partial' | 'trace';

/**
 * metadata.json content (fcpp single source of truth).
 * Only fields the extension reads/writes are typed; unknown keys pass through.
 */
export interface FcppMetadata {
  name: string;
  target?: string;
  version?: string;
  team?: string;
  license?: string;
  description?: string;
  authors?: string[];
  maintainers?: string[];
  topics?: string[];
  cmake_version?: string;
  build_cppstd?: string;
  build_cstd?: string;
  build_type?: string;
  activate_code_coverage?: boolean;
  is_shared?: boolean;
  is_header?: boolean;
  generate_modules_inplace?: boolean;
  std_modules?: string | string[];
  user_modules?: string;
  dependencies?: FcppDependencyBuckets;
  baremetal_white_list?: string[];
  graphviz_bin?: string;
  doc_languages?: string[];
  doc_versions?: string[];
  doc_doxygen_folders?: string[];
  doc_doxygen_suffix?: string[];
  trigger_tests?: boolean;
  saving_tests_log?: boolean;
  enable_python_bindings?: boolean;
  workflow_triggers?: FcppWorkflowTriggers;
  [key: string]: unknown;
}

/** Dependency buckets: one package belongs to exactly one bucket. */
export interface FcppDependencyBuckets {
  common?: Record<string, string[]>;
  c?: Record<string, string[]>;
  cpp?: Record<string, string[]>;
  infra?: Record<string, string[]>;
}

export interface FcppWorkflowTriggers {
  build?: boolean;
  tests?: boolean;
  release?: boolean;
  docs?: boolean;
  security_scan?: boolean;
  /**
   * 推提交时是否触发 🛠️ 交叉编译流水线（`cross-compile.yml`）。
   *
   * 模板的 `metadata.schema.json` 把它列为**必填**（六个开关里的一个），所以这里必须有
   * —— 之前类型里漏了它，于是扩展读不到也写不出这个开关（用户只能手改 JSON）。
   */
  cross_compile?: boolean;
}

/** Result of probing an external tool. */
export interface ToolStatus {
  name: string;
  state: 'ok' | 'missing' | 'versionMismatch';
  /** Absolute path of the found executable. */
  foundPath?: string;
  /** Reported version string. */
  version?: string;
  /** Version constraint for display (human readable). */
  required?: string;
}

/** A compiler error/warning parsed from build output. */
export interface ParsedIssue {
  severity: 'error' | 'warning';
  /** File path as printed by the compiler. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column when the compiler prints it. */
  column?: number;
  /** The compiler message (without the file:line prefix). */
  message: string;
  /** Compiler family that produced the line. */
  origin: 'msvc' | 'gcc-clang' | 'unknown';
}
