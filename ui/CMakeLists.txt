add_library(dr_shell STATIC src/window.cpp)
target_include_directories(dr_shell PUBLIC include)
target_compile_definitions(dr_shell PUBLIC NOMINMAX WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
target_link_libraries(dr_shell PUBLIC d2d1 dwrite dwmapi user32 gdi32 advapi32 winmm)
