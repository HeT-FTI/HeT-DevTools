cmake_minimum_required(VERSION 3.28)
project(PackageTest C CXX)


function(parse_conan_deps INPUT_VAR OUTPUT_VAR)

    set(INPUT_STR "${${INPUT_VAR}}")

    string(REPLACE "[" "" CLEANED_STR "${INPUT_STR}")
    string(REPLACE "]" "" CLEANED_STR "${CLEANED_STR}")
    string(REPLACE "'" "" CLEANED_STR "${CLEANED_STR}")

    string(REPLACE ", " ";" LIST_ITEMS "${CLEANED_STR}")

    set(RESULT_LIST "")

    foreach(ITEM IN LISTS LIST_ITEMS)
        list(APPEND RESULT_LIST "${ITEM}")
    endforeach()

    set("${OUTPUT_VAR}" "${RESULT_LIST}" PARENT_SCOPE)
endfunction()


function(split_conan_dependency INPUT_STR PACKAGE_NAME TARGETS)

    if(NOT DEFINED ${INPUT_STR} OR "${${INPUT_STR}}" STREQUAL "")
        message(FATAL_ERROR "Input string is empty or undefined")
    endif()

    string(FIND "${${INPUT_STR}}" "@" AT_POS)
    if(AT_POS EQUAL -1)
        message(FATAL_ERROR "Input string does not contain '@': ${${INPUT_STR}}")
    endif()

    string(SUBSTRING "${${INPUT_STR}}" 0 ${AT_POS} PACKAGE_NAME_RAW)

    math(EXPR AFTER_AT_START "${AT_POS} + 1")
    string(SUBSTRING "${${INPUT_STR}}" ${AFTER_AT_START} -1 TARGETS_RAW)

    set("${PACKAGE_NAME}" "${PACKAGE_NAME_RAW}" PARENT_SCOPE)
    set("${TARGETS}" "${TARGETS_RAW}" PARENT_SCOPE)
endfunction()


function(link_to_resources EXECUTE_FILE)
  if(DEFINED RESOURCES_PATH)
    string(REPLACE "\\" "/" RESOURCES_PATH "${RESOURCES_PATH}")
    target_compile_definitions(${EXECUTE_FILE} PRIVATE RESOURCES_PATH="${RESOURCES_PATH}")
  endif()
endfunction()


function(apply_unit_coverage U_NAME U_FILE)
    find_package(GTest REQUIRED)
    add_executable(${U_NAME} ${U_FILE})
    link_to_resources(${U_NAME})
    target_link_libraries(${U_NAME} PRIVATE ${MAIN_LIB_TARGET} GTest::gtest)
    gtest_discover_tests(${U_NAME})

    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU")
        set(COVERAGE_FLAGS "--coverage" "-O0" "-g")
        set(LINK_FLAGS "--coverage")
    elseif(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
        set(COVERAGE_FLAGS "-fprofile-instr-generate" "-fcoverage-mapping" "-O0" "-g")
        set(LINK_FLAGS "-fprofile-instr-generate")
    else()
        message(FATAL_ERROR "Code coverage not support for compiler: ${CMAKE_CXX_COMPILER_ID}")
    endif()

    target_compile_options(${U_NAME} PRIVATE ${COVERAGE_FLAGS})
    if(LINK_FLAGS)
        target_link_options(${U_NAME} PRIVATE ${LINK_FLAGS})
    endif()
endfunction()


function(enable_main_coverage)
    find_package(GTest REQUIRED)
    include(GoogleTest)

    target_link_libraries(main PRIVATE GTest::gtest)
    enable_testing()
    gtest_discover_tests(main)

    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU")
        set(COVERAGE_FLAGS "--coverage" "-O0" "-g")
        set(LINK_FLAGS "--coverage")
    elseif(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
        set(COVERAGE_FLAGS "-fprofile-instr-generate" "-fcoverage-mapping" "-O0" "-g")
        set(LINK_FLAGS "-fprofile-instr-generate")
    else()
        message(FATAL_ERROR "Code coverage not support for compiler: ${CMAKE_CXX_COMPILER_ID}")
    endif()

    target_compile_options(main PRIVATE ${COVERAGE_FLAGS})
    if(LINK_FLAGS)
        target_link_options(main PRIVATE ${LINK_FLAGS})
    endif()
endfunction()


add_executable(main main.cpp)
link_to_resources(main)


if(TRIGGER_TESTS AND ENABLE_COVERAGE)
    enable_main_coverage()
endif()

if(NOT CXX_DEPS STREQUAL "[]")
    parse_conan_deps(CXX_DEPS PARSED_CXX_DEPS)
    foreach (CXX_ITEM IN LISTS PARSED_CXX_DEPS)
        split_conan_dependency(CXX_ITEM CXX_PKG_NAME CXX_PKG_TARGETS)
        find_package(${CXX_PKG_NAME} REQUIRED)
        target_link_libraries(main PRIVATE ${CXX_PKG_TARGETS})
    endforeach ()
endif()

target_include_directories(main PRIVATE ${${LIB_NAME}_INCLUDE_DIRS})

if(TRIGGER_TESTS)
    find_package(${LIB_NAME} REQUIRED)
    find_package(GTest REQUIRED)
    include(GoogleTest)
    enable_testing()
    
    if(NOT ENABLE_COVERAGE)
      file(GLOB_RECURSE TEST_SOURCES_S "test/stress/*.cpp")
      add_executable(stress_tests ${TEST_SOURCES_S})
      link_to_resources(stress_tests)
      target_link_libraries(stress_tests PRIVATE ${MAIN_LIB_TARGET} GTest::gtest)
      gtest_discover_tests(stress_tests)
    endif()

    file(GLOB_RECURSE TEST_SOURCES_U "test/unit/*.cpp")
    if(NOT ENABLE_COVERAGE)
        add_executable(unit_tests ${TEST_SOURCES_U})
        link_to_resources(unit_tests)
        target_link_libraries(unit_tests PRIVATE ${MAIN_LIB_TARGET} GTest::gtest)
        gtest_discover_tests(unit_tests)
    else()
        foreach(U_SOURCE IN LISTS TEST_SOURCES_U)
            get_filename_component(U_NAME ${U_SOURCE} NAME_WE)
            string(SUBSTRING ${U_NAME} 0 5 U_NAME_PREFIX)
            if(U_NAME_PREFIX STREQUAL "ucov_")
                apply_unit_coverage(${U_NAME} ${U_SOURCE})
            endif()
        endforeach()
    endif()
endif()
