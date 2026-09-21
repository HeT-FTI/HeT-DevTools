/**
 * bench_entry.c  –  Algorithm Benchmark Entry
 *
 * ============================================================
 *  HOW TO USE (algorithm engineer)
 * ============================================================
 *  1. Set MODULE_NAME to identify this build (e.g. "MyAlgo-v2.0").
 *  2. Include your algorithm header(s) below.
 *  3. Add static wrapper functions (one per test item).
 *  4. Add entries to bench_table[].
 *  5. Build with:  conan build . -pr:h profiles/<target>.profile
 *
 *  Everything else (linker script, descriptor, RAM init, timing)
 *  is handled automatically – do NOT modify below the separator.
 * ============================================================
 */
#include <stdint.h>
#include <array>
#include "core/het_bench_core.h"

// Include algorithm headers here. For example:
#include "etl.hpp"


/* ============================================================
 * USER ZONE (algorithm engineer edits only this block)
 * ============================================================ */

constexpr const char *MODULE_NAME = "LibBench";
constexpr uint32_t BENCH_VECTOR_LEN = 128U;

namespace {
struct BenchState {
	std::array<float, BENCH_VECTOR_LEN> a;
	std::array<float, BENCH_VECTOR_LEN> b;
	std::array<float, BENCH_VECTOR_LEN> y;
};

BenchState &bench_state(void)
{
	// Function-local static avoids cross-translation-unit state pollution
	static BenchState state = {};
	return state;
}
}  // namespace

static void bench_prepare_input(void)
{
	for (uint32_t i = 0U; i < BENCH_VECTOR_LEN; ++i) {
		bench_state().a[i] = (float)i * 0.25f;
		bench_state().b[i] = (float)(BENCH_VECTOR_LEN - i) * 0.5f;
		bench_state().y[i] = 0.0f;
	}
}

static int bench_add_case(const void * const ctx) // NOSONAR: opaque ctx required by the pFunCase C ABI for cross-language binary compatibility.
{
	(void)ctx;
	fcpp_vec_add_f32(bench_state().a.data(), bench_state().b.data(),
	                 bench_state().y.data(), BENCH_VECTOR_LEN);
	return bench_state().y[0] == (bench_state().a[0] + bench_state().b[0]);
}

static int bench_sub_case(const void * const ctx) // NOSONAR: opaque ctx required by the pFunCase C ABI for cross-language binary compatibility.
{
	(void)ctx;
	fcpp_vec_sub_f32(bench_state().a.data(), bench_state().b.data(),
	                 bench_state().y.data(), BENCH_VECTOR_LEN);
	return bench_state().y[0] == (bench_state().a[0] - bench_state().b[0]);
}

static const Case bench_table[] = { // NOSONAR: must stay a C array - BENCHMARK_IMPLEMENTATION consumes it as a C-compatible aggregate.
	BENCHMARK_CASE_IMPLEMENTATION("test_add_n128", nullptr, bench_add_case, 100U),
	BENCHMARK_CASE_IMPLEMENTATION("test_sub_n128", nullptr, bench_sub_case, 100U),
};


BENCHMARK_IMPLEMENTATION(MODULE_NAME, bench_table);
