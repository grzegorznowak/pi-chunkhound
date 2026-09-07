/*
 * f2p-clones.c — prove APFS clone sharing between two files, unprivileged.
 *
 * Prints "1" when every block of fileA and fileB maps to the same PHYSICAL
 * device offset (F_LOG2PHYS_EXT), i.e. the files share extents (clones);
 * prints "0" when any block differs (independent copies, or a clone whose
 * data was copy-on-write diverged). Exit 2 with a message on API failure.
 *
 * Adapted from dyorgio/apfs-clone-checker (MIT):
 *   https://github.com/dyorgio/apfs-clone-checker
 *   Copyright (c) 2020 Dyorgio Nascimento
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the
 *   "Software"), to deal in the Software without restriction, including
 *   without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to
 *   permit persons to whom the Software is furnished to do so, subject to
 *   the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included
 *   in all copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 *   OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 *   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 *   LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 *   OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 *   WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 * macOS-only (APFS). Compile: cc -O1 -o f2p-clones f2p-clones.c
 */
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>
#include <sys/stat.h>

static int fail(const char *what, const char *path) {
	fprintf(stderr, "f2p-clones: %s %s: %s\n", what, path, strerror(errno));
	return 2;
}

int main(int argc, char **argv) {
	if (argc != 3) {
		fprintf(stderr, "usage: %s fileA fileB\n", argv[0]);
		return 2;
	}
	struct stat sa, sb;
	if (stat(argv[1], &sa) < 0) return fail("stat", argv[1]);
	if (stat(argv[2], &sb) < 0) return fail("stat", argv[2]);
	if (!S_ISREG(sa.st_mode) || !S_ISREG(sb.st_mode)) {
		fprintf(stderr, "f2p-clones: both paths must be regular files\n");
		return 2;
	}
	if (sa.st_dev != sb.st_dev || sa.st_size != sb.st_size || sa.st_size < 1 || sa.st_ino == sb.st_ino) {
		puts("0");
		return 0;
	}
	int fda = open(argv[1], O_RDONLY);
	if (fda < 0) return fail("open", argv[1]);
	int fdb = open(argv[2], O_RDONLY);
	if (fdb < 0) {
		int err = errno;
		close(fda);
		errno = err;
		return fail("open", argv[2]);
	}
	int result = 2;
	const long blk = sa.st_blksize > 0 ? sa.st_blksize : 4096;
	for (off_t off = 0; ; off += blk) {
		struct log2phys pa, pb;
		memset(&pa, 0, sizeof(pa));
		memset(&pb, 0, sizeof(pb));
		pa.l2p_devoffset = off;
		pb.l2p_devoffset = off;
		long ra = fcntl(fda, F_LOG2PHYS_EXT, &pa);
		long rb = fcntl(fdb, F_LOG2PHYS_EXT, &pb);
		if (ra < 0 || rb < 0) {
			if (ra < 0 && rb < 0 && errno == ERANGE) {
				/* Both files ended at the same offset with every prior block
				 * matching physical location — the files share all extents. */
				result = 1;
			} else {
				fprintf(stderr, "f2p-clones: F_LOG2PHYS_EXT: %s\n", strerror(errno));
			}
			break;
		}
		if (pa.l2p_devoffset != pb.l2p_devoffset) {
			result = 0;
			break;
		}
	}
	close(fda);
	close(fdb);
	if (result == 0) puts("0");
	else if (result == 1) puts("1");
	return result == 2 ? 2 : 0;
}
