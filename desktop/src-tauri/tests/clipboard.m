#import <AppKit/AppKit.h>
#include <assert.h>
extern bool keep_pasteboard_has_image(NSPasteboard *pasteboard);
int main(void) {
    @autoreleasepool {
        // A private pasteboard keeps the user's current clipboard untouched.
        NSPasteboard *board = [NSPasteboard pasteboardWithUniqueName];
        assert(!keep_pasteboard_has_image(board));
        [board setString:@"normal text\nwith newlines" forType:NSPasteboardTypeString];
        assert(!keep_pasteboard_has_image(board));
        for (NSString *type in @[NSPasteboardTypePNG, NSPasteboardTypeTIFF, @"public.jpeg", @"public.heic"]) {
            [board clearContents];
            [board setData:[NSData data] forType:type];
            assert(keep_pasteboard_has_image(board));
        }
        [board clearContents];
        [board setString:@"file:///tmp/example.txt" forType:NSPasteboardTypeFileURL];
        assert(!keep_pasteboard_has_image(board));
        [board releaseGlobally];
    }
    return 0;
}
