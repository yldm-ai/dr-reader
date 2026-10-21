# WebView2 SDK is fetched at configure time. The Evergreen runtime is supplied by Windows/Edge.
set(DR_WEBVIEW2_VERSION "1.0.2903.40" CACHE STRING "Pinned WebView2 SDK")
FetchContent_Declare(webview2 URL "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/${DR_WEBVIEW2_VERSION}" DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(webview2)
add_executable(dr-reader WIN32 src/main.cpp src/application.cpp src/webview.cpp app.rc)
target_include_directories(dr-reader PRIVATE src "${webview2_SOURCE_DIR}/build/native/include")
target_link_libraries(dr-reader PRIVATE dr_engine dr_shell "${webview2_SOURCE_DIR}/build/native/x64/WebView2LoaderStatic.lib" ole32 shell32 shlwapi comdlg32 version)
target_link_options(dr-reader PRIVATE /MANIFEST:NO)
set_target_properties(dr-reader PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
find_program(DR_PNPM_EXECUTABLE NAMES pnpm.cmd pnpm REQUIRED)
file(GLOB_RECURSE DR_FRONTEND_SOURCES CONFIGURE_DEPENDS
  "${PROJECT_SOURCE_DIR}/web/*.js" "${PROJECT_SOURCE_DIR}/web/*.ts"
  "${PROJECT_SOURCE_DIR}/web/*.css" "${PROJECT_SOURCE_DIR}/web/*.html")
add_custom_command(OUTPUT "${CMAKE_BINARY_DIR}/frontend.stamp"
  BYPRODUCTS "${PROJECT_SOURCE_DIR}/dist/index.html"
  COMMAND "${DR_PNPM_EXECUTABLE}" run build
  COMMAND ${CMAKE_COMMAND} -E touch "${CMAKE_BINARY_DIR}/frontend.stamp"
  WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
  DEPENDS ${DR_FRONTEND_SOURCES} "${PROJECT_SOURCE_DIR}/package.json"
    "${PROJECT_SOURCE_DIR}/pnpm-lock.yaml" "${PROJECT_SOURCE_DIR}/tsconfig.json"
    "${PROJECT_SOURCE_DIR}/vite.config.ts"
  COMMENT "Type checking and bundling the WebView2 UI with Vite"
  VERBATIM)
add_custom_target(dr-assets
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${PROJECT_SOURCE_DIR}/dist" "$<TARGET_FILE_DIR:dr-reader>/web"
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${PROJECT_SOURCE_DIR}/resources" "$<TARGET_FILE_DIR:dr-reader>/resources"
  DEPENDS "${CMAKE_BINARY_DIR}/frontend.stamp"
  COMMENT "Synchronizing bundled reader web assets")
add_dependencies(dr-reader dr-assets)
install(TARGETS dr-reader RUNTIME DESTINATION . COMPONENT Runtime)
install(DIRECTORY "${PROJECT_SOURCE_DIR}/dist/" DESTINATION web COMPONENT Runtime)
install(DIRECTORY "${PROJECT_SOURCE_DIR}/resources" DESTINATION . COMPONENT Runtime)
