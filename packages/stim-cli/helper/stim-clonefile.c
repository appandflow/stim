// Clones each <source> to its <destination> with one clonefile(2) call, which on APFS clones a whole directory
// hierarchy in a single operation instead of one file at a time. A <destination> must not exist. clonefile(2) fails
// with EXDEV across volumes and ENOTSUP on file systems without clone support; the first error goes to stderr with its
// destination, the exit status is 1 and the pairs after it are not cloned.

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/clonefile.h>

int main(int argc, char **argv) {
  if (argc < 3 || argc % 2 == 0) {
    fputs("usage: stim-clonefile <source> <destination> [<source> <destination>]...\n", stderr);
    return 64;
  }
  for (int i = 1; i < argc; i += 2) {
    if (clonefile(argv[i], argv[i + 1], CLONE_NOFOLLOW) == 0) continue;
    fprintf(stderr, "clonefile %s: %s\n", argv[i + 1], strerror(errno));
    return 1;
  }
  return 0;
}
