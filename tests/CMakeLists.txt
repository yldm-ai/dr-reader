add_executable(dr-engine-tests engine_tests.cpp)
target_link_libraries(dr-engine-tests PRIVATE dr_engine miniz)
add_test(NAME engine COMMAND dr-engine-tests)
add_executable(dr-epub ../tools/epub_cli.cpp)
target_link_libraries(dr-epub PRIVATE dr_engine)
set_target_properties(dr-epub dr-engine-tests PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

# JavaScript navigation tests use Node's built-in runner; no npm dependencies.
find_program(DR_NODE_EXECUTABLE NAMES node)
if(DR_NODE_EXECUTABLE)
  execute_process(COMMAND "${DR_NODE_EXECUTABLE}" --version
    OUTPUT_VARIABLE DR_NODE_VERSION OUTPUT_STRIP_TRAILING_WHITESPACE)
  string(REGEX REPLACE "^v" "" DR_NODE_VERSION "${DR_NODE_VERSION}")
  if(DR_NODE_VERSION VERSION_GREATER_EQUAL "22.7")
    add_test(NAME reader-navigation COMMAND "${DR_NODE_EXECUTABLE}"
      --test "${CMAKE_CURRENT_SOURCE_DIR}/reader_navigation_tests.mjs")
  endif()
endif()
