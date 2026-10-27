// Clones <source> to <destination> with one clonefile(2) call, which on APFS clones a whole directory hierarchy in a
// single operation instead of one file at a time. <destination> must not exist. clonefile(2) fails with EXDEV across
// volumes and ENOTSUP on file systems without clone support; the error goes to stderr and the exit status is 1.

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/clonefile.h>

int main(int argc, char **argv) {
  if (argc != 3) {
    fputs("usage: stim-clonefile <source> <destination>\n", stderr);
    return 64;
  }
  if (clonefile(argv[1], argv[2], CLONE_NOFOLLOW) == 0) return 0;
  fprintf(stderr, "clonefile: %s\n", strerror(errno));
  return 1;
}
