#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <UserNotifications/UserNotifications.h>

extern void keep_notification_clicked(const char *key);

@interface KeepNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation KeepNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
    didReceiveNotificationResponse:(UNNotificationResponse *)response
    withCompletionHandler:(void (^)(void))completionHandler {
    if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) {
        NSString *key = response.notification.request.content.userInfo[@"keepKey"];
        if ([key isKindOfClass:[NSString class]]) keep_notification_clicked(key.UTF8String);
    }
    completionHandler();
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
    willPresentNotification:(UNNotification *)notification
    withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList);
}
@end

bool keep_init_notifications(void) {
    // UNUserNotificationCenter requires a bundle; `cargo run` has none.
    if (!NSBundle.mainBundle.bundleIdentifier.length) return false;
    static KeepNotificationDelegate *delegate;
    if (!delegate) delegate = [KeepNotificationDelegate new];
    [UNUserNotificationCenter currentNotificationCenter].delegate = delegate;
    return true;
}

void keep_send_notification(const char *title, const char *body, const char *key) {
    // Copy the FFI strings before returning to Rust. The completion blocks retain them.
    NSString *notificationTitle = [NSString stringWithUTF8String:title];
    NSString *notificationBody = [NSString stringWithUTF8String:body];
    NSString *notificationKey = [NSString stringWithUTF8String:key];
    dispatch_async(dispatch_get_main_queue(), ^{
        UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
        [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
            completionHandler:^(BOOL granted, NSError *error) {
                if (!granted || error) return;
                UNMutableNotificationContent *content = [UNMutableNotificationContent new];
                content.title = notificationTitle;
                content.body = notificationBody;
                // Queue transitions own audio; banners stay silent.
                content.userInfo = @{@"keepKey": notificationKey};
                NSString *identifier = notificationKey.length ? notificationKey : NSUUID.UUID.UUIDString;
                UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier content:content trigger:nil];
                [center addNotificationRequest:request withCompletionHandler:^(NSError *error) {
                    if (error) NSLog(@"Keep notification failed: %@", error);
                }];
            }];
    });
}

void keep_play_attention_sound(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [[NSSound soundNamed:@"Pop"] play];
    });
}
