import { DepBucket } from '../core/dependencyService';

/**
 * Built-in curated ConanCenter index (V2-3, offline first).
 * Sourced from common C/C++ usage; the extension NEVER auto-refreshes over the
 * network — `het.refreshConanIndex` replaces/augments this cache explicitly.
 */

export interface CuratedEntry {
  /** conan package name (conancenter). */
  conan: string;
  /** A handful of known-good versions, newest first. */
  versions: string[];
  /** Suggested fcpp bucket. */
  bucket: DepBucket;
  /** One-line hint (what it is / typical target). */
  note: string;
}

export const CURATED_PACKAGES: CuratedEntry[] = [
  // -- C 类库 (bucket: c)
  { conan: 'zlib', versions: ['1.3.1', '1.3', '1.2.13'], bucket: 'c', note: '压缩库，几乎无处不在' },
  { conan: 'bzip2', versions: ['1.0.8'], bucket: 'c', note: 'bzip2 压缩' },
  { conan: 'xz_utils', versions: ['5.6.3', '5.6.2'], bucket: 'c', note: 'XZ/LZMA 压缩' },
  { conan: 'libpng', versions: ['1.6.47', '1.6.46'], bucket: 'c', note: 'PNG 解码' },
  { conan: 'libjpeg-turbo', versions: ['3.1.0', '3.0.4'], bucket: 'c', note: 'JPEG 编解码（SIMD）' },
  { conan: 'openssl', versions: ['3.4.1', '3.3.2'], bucket: 'c', note: 'TLS/加密' },
  { conan: 'libcurl', versions: ['8.11.1', '8.10.1'], bucket: 'c', note: 'HTTP 客户端' },
  { conan: 'sqlite3', versions: ['3.49.1', '3.47.2'], bucket: 'c', note: '嵌入式 SQL 数据库' },
  { conan: 'mbedtls', versions: ['3.6.2', '2.28.9'], bucket: 'c', note: '轻量 TLS（嵌入式友好）' },
  { conan: 'brotli', versions: ['1.1.0'], bucket: 'c', note: '通用压缩（HTTP 友好）' },
  { conan: 'libdeflate', versions: ['1.23'], bucket: 'c', note: '快速 DEFLATE' },
  // -- C++ 类库 (bucket: cpp)
  { conan: 'eigen', versions: ['3.4.0', '3.3.9'], bucket: 'cpp', note: '线性代数头文件库' },
  { conan: 'fmt', versions: ['11.1.4', '10.2.1'], bucket: 'cpp', note: '格式化输出（现代 printf）' },
  { conan: 'spdlog', versions: ['1.15.3', '1.14.1'], bucket: 'cpp', note: '日志库（基于 fmt）' },
  { conan: 'nlohmann_json', versions: ['3.12.0', '3.11.3'], bucket: 'cpp', note: 'JSON for Modern C++' },
  { conan: 'yaml-cpp', versions: ['0.8.0'], bucket: 'cpp', note: 'YAML 解析' },
  { conan: 'tomlplusplus', versions: ['3.4.0', '3.3.0'], bucket: 'cpp', note: 'TOML 解析' },
  { conan: 'range-v3', versions: ['0.12.0'], bucket: 'cpp', note: 'Range 库' },
  { conan: 'magic_enum', versions: ['0.9.7', '0.9.6'], bucket: 'cpp', note: 'enum 反射/字符串化' },
  { conan: 'fast_float', versions: ['8.0.0', '6.1.6'], bucket: 'cpp', note: '快速 float 解析' },
  { conan: 'simdjson', versions: ['3.12.0', '3.10.1'], bucket: 'cpp', note: '极速 JSON' },
  { conan: 'CLI11', versions: ['2.5.0', '2.4.2'], bucket: 'cpp', note: '命令行解析（头文件）' },
  { conan: 'cxxopts', versions: ['3.2.1', '3.1.1'], bucket: 'cpp', note: '轻量命令行解析' },
  { conan: 'abseil', versions: ['20250127.1', '20240722.0'], bucket: 'cpp', note: 'Google 基础库' },
  { conan: 'msgpack', versions: ['7.0.0', '6.1.1'], bucket: 'cpp', note: 'MessagePack 序列化' },
  { conan: 'cereal', versions: ['1.3.2', '1.3.1'], bucket: 'cpp', note: 'C++ 序列化库（头文件）' },
  // -- 测试 / 通用基础设施 (bucket: common)
  { conan: 'gtest', versions: ['1.15.2', '1.14.0'], bucket: 'infra', note: 'GoogleTest（测试框架；规则固定归 infra）' },
  { conan: 'doctest', versions: ['2.4.11'], bucket: 'common', note: '轻量单测框架（单头文件）' },
  { conan: 'catch2', versions: ['3.8.0', '2.13.10'], bucket: 'common', note: 'Catch2 测试框架' },
  { conan: 'benchmark', versions: ['1.9.1', '1.8.5'], bucket: 'common', note: 'Google Benchmark（微基准）' },
  // -- 语言绑定基础设施 (bucket: infra)
  { conan: 'pybind11', versions: ['2.13.6', '2.12.0'], bucket: 'infra', note: 'Python 绑定（需 enable_python_bindings）' },
];
