// Conan::ImportStart
#include <ctest.h>
#include <stdio.h>
#ifndef __ARM_EABI__
#include <zlib.h>
#define PCRE2_CODE_UNIT_WIDTH 8
#include <pcre2.h>
#endif
// Conan::ImportEnd



/**
 * @brief [en] the C function
 * @brief [zh] 测试用C函数
 * @exporter
 */
void test_c_compiler() {
    _Static_assert(1, "for C Compiler only"); // _Static_assert: C only syntax
    fputs("C Compiler is ready!\n", stdout);
}



/**
 * @brief _Generic requirement test in C compiler
 * @exporter
 */
void test_c_generic() {
    // _Generic picks one branch at compile time from the controlling expression's type
    _Static_assert(sizeof(_Generic((short)1, short: (char)0, default: 0)) == sizeof(char),
                   "_Generic must select the short branch, not the default one");

    const char *as_int = _Generic(1, int: "int", long: "long", double: "double", default: "other");
    const char *as_long = _Generic(1L, int: "int", long: "long", double: "double", default: "other");
    const char *as_double = _Generic(1.0, int: "int", long: "long", double: "double", default: "other");
    fputs("_Generic test: 1 -> ", stdout);
    fputs(as_int, stdout);
    fputs(", 1L -> ", stdout);
    fputs(as_long, stdout);
    fputs(", 1.0 -> ", stdout);
    fputs(as_double, stdout);
    fputs("\n", stdout);
}



#ifndef __ARM_EABI__
/**
 * @brief zlib requirement test in C compiler
 * @exporter
 */
void test_c_zlib() {
    char in[] = "Hello, zlib in C!";
    Byte out[128];
    Byte rec[128];
    uLong len_out = 128;
    uLong len_rec = 128;
    compress(out, &len_out, in, sizeof(in));
    uncompress(rec, &len_rec, out, len_out);
    fputs("Original: ", stdout);
    fputs(in, stdout);
    fputs("; Decompressed: ", stdout);
    fputs((const char *)rec, stdout);
    fputs("; zlib in C test done!\n", stdout);
}



/**
 * @brief pcre2 requirement test in C compiler
 * @exporter
 */
void test_c_pcre() {
    pcre2_code *re = pcre2_compile((PCRE2_SPTR) "a", PCRE2_ZERO_TERMINATED, 0, NULL, NULL, NULL);
    int rc = pcre2_match(re, (PCRE2_SPTR) "abc", 3, 0, 0, NULL, NULL);
    fputs(rc >= 0 ? "PCRE2 test: Match\n" : "PCRE2 test: No match\n", stdout);
    pcre2_code_free(re);
}
#endif /* __ARM_EABI__ */
