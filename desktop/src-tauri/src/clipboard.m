#import <AppKit/AppKit.h>

// Format-only query. No clipboard bytes, filenames, or text cross the web bridge.
bool keep_pasteboard_has_image(NSPasteboard *pasteboard) {
    return [pasteboard availableTypeFromArray:@[
        NSPasteboardTypePNG, NSPasteboardTypeTIFF,
        @"public.jpeg", @"public.heic", @"com.compuserve.gif", @"org.webmproject.webp"
    ]] != nil;
}

bool keep_clipboard_has_image(void) {
    __block bool result = false;
    void (^readFormats)(void) = ^{
        @autoreleasepool { result = keep_pasteboard_has_image(NSPasteboard.generalPasteboard); }
    };
    if (NSThread.isMainThread) readFormats();
    else dispatch_sync(dispatch_get_main_queue(), readFormats);
    return result;
}
