# WebView2 SDK is fetched at configure time. The Evergreen runtime is supplied by Windows/Edge.
set(DR_WEBVIEW2_VERSION "1.0.2903.40" CACHE STRING "Pinned WebView2 SDK")
FetchContent_Declare(webview2 URL "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/${DR_WEBVIEW2_VERSION}" DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(webview2)
add_executable(dr-reader WIN32 src/main.cpp src/application.cpp src/webview.cpp app.rc)
target_include_directories(dr-reader PRIVATE src "${webview2_SOURCE_DIR}/build/native/include")
target_link_libraries(dr-reader PRIVATE dr_engine dr_shell "${webview2_SOURCE_DIR}/build/native/x64/WebView2LoaderStatic.lib" ole32 shell32 shlwapi comdlg32 version)
target_link_options(dr-reader PRIVATE /MANIFEST:NO)
set_target_properties(dr-reader PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
add_custom_target(dr-assets
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${PROJECT_SOURCE_DIR}/web" "$<TARGET_FILE_DIR:dr-reader>/web"
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${PROJECT_SOURCE_DIR}/resources" "$<TARGET_FILE_DIR:dr-reader>/resources"
  COMMENT "Synchronizing reader web assets")
add_dependencies(dr-reader dr-assets)
install(TARGETS dr-reader RUNTIME DESTINATION . COMPONENT Runtime)
install(DIRECTORY "${PROJECT_SOURCE_DIR}/web" DESTINATION . COMPONENT Runtime)
install(DIRECTORY "${PROJECT_SOURCE_DIR}/resources" DESTINATION . COMPONENT Runtime)
