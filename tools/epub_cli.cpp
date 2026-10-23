#include "dr/library.h"
#include <iostream>
int run(int argc, const dr::fs::path &root, const dr::fs::path &file, bool info)
{
    try
    {
        if (argc < 3)
        {
            std::cerr << "Usage: dr-epub <data-directory> <book.epub> [--info]\n";
            return 2;
        }
        dr::Library library(root);
        auto book = library.import_book(file);
        // --info prints the book details view: OPF metadata and word counts.
        std::cout << (info ? library.info(book.at("id").get<std::string>()) : book).dump(2) << '\n';
        return 0;
    }
    catch (const std::exception &e)
    {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
#ifdef _WIN32
int wmain(int argc, wchar_t **argv)
{
    return run(argc, argc > 1 ? dr::fs::path(argv[1]) : dr::fs::path(),
               argc > 2 ? dr::fs::path(argv[2]) : dr::fs::path(), argc > 3 && std::wstring(argv[3]) == L"--info");
}
#else
int main(int argc, char **argv)
{
    return run(argc, argc > 1 ? dr::path8(argv[1]) : dr::fs::path(),
               argc > 2 ? dr::path8(argv[2]) : dr::fs::path(), argc > 3 && std::string(argv[3]) == "--info");
}
#endif
