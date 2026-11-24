#import <GoogleSignIn/GoogleSignIn.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>
#import <React/RCTUtils.h>

@interface GoogleAuth : NSObject <RCTBridgeModule, RCTInvalidating>
@property(nonatomic, copy) RCTPromiseResolveBlock pendingResolve;
@property(nonatomic, copy) RCTPromiseRejectBlock pendingReject;
@property(nonatomic, assign) BOOL authInProgress;
@property(nonatomic, assign) BOOL invalidated;
@end

@implementation GoogleAuth
RCT_EXPORT_MODULE(GoogleAuth)

+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

- (void)finishWithToken:(NSString *)token code:(NSString *)code message:(NSString *)message {
  RCTPromiseResolveBlock resolve = self.pendingResolve;
  RCTPromiseRejectBlock reject = self.pendingReject;
  self.pendingResolve = nil;
  self.pendingReject = nil;
  self.authInProgress = NO;
  if (code) {
    // Do not retain a Google session when no application session was created.
    [GIDSignIn.sharedInstance signOut];
    if (reject) reject(code, message, nil);
  } else if (resolve) {
    resolve(token);
  }
}

- (BOOL)discardCancelledRequest {
  if (!self.invalidated && self.pendingResolve) return NO;
  [GIDSignIn.sharedInstance signOut];
  self.authInProgress = NO;
  return YES;
}

- (void)finishWithGoogleError:(NSError *)error {
  BOOL cancelled = [error.domain isEqualToString:kGIDSignInErrorDomain] &&
      error.code == kGIDSignInErrorCodeCanceled;
  NSString *message = cancelled ? @"Đã hủy đăng nhập Google." :
      @"Không đăng nhập được Google. Vui lòng kiểm tra kết nối và thử lại.";
  if ([error.domain isEqualToString:kGIDSignInErrorDomain] &&
      error.code == kGIDSignInErrorCodeKeychain) {
    message = @"Không truy cập được thông tin đăng nhập trên iPhone. Vui lòng kiểm tra cấu hình ký ứng dụng.";
  }
  [self finishWithToken:nil code:cancelled ? @"CANCELLED" : @"GOOGLE_SIGN_IN_FAILED" message:message];
}

RCT_EXPORT_METHOD(signIn:(NSString *)serverClientID
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (self.authInProgress || self.invalidated) {
    reject(@"GOOGLE_SIGN_IN_BUSY", @"Một cửa sổ Google đang mở. Vui lòng đóng cửa sổ đó trước khi thử lại.", nil);
    return;
  }
  NSDictionary *info = NSBundle.mainBundle.infoDictionary;
  NSString *clientID = info[@"GIDClientID"];
  NSString *configuredServerID = info[@"GIDServerClientID"];
  NSString *suffix = @".apps.googleusercontent.com";
  if (![clientID isKindOfClass:NSString.class] || ![clientID hasSuffix:suffix] ||
      clientID.length <= suffix.length || [clientID isEqualToString:serverClientID]) {
    reject(@"GOOGLE_CONFIG", @"Bản iOS chưa được cấu hình Google Client ID. Vui lòng cập nhật cấu hình iOS và cài lại ứng dụng.", nil);
    return;
  }
  if (![serverClientID isKindOfClass:NSString.class] || ![serverClientID hasSuffix:suffix] ||
      ![configuredServerID isEqualToString:serverClientID]) {
    reject(@"GOOGLE_CONFIG", @"Cấu hình Google của ứng dụng và máy chủ chưa khớp. Vui lòng cập nhật ứng dụng.", nil);
    return;
  }
  NSString *reversedID = [[[clientID componentsSeparatedByString:@"."] reverseObjectEnumerator].allObjects componentsJoinedByString:@"."];
  BOOL hasCallbackScheme = NO;
  for (NSDictionary *urlType in info[@"CFBundleURLTypes"]) {
    if ([urlType[@"CFBundleURLSchemes"] containsObject:reversedID]) {
      hasCallbackScheme = YES;
      break;
    }
  }
  if (!hasCallbackScheme) {
    reject(@"GOOGLE_CONFIG", @"Bản iOS thiếu liên kết quay lại từ Google. Vui lòng cập nhật ứng dụng.", nil);
    return;
  }
  UIViewController *presenter = RCTPresentedViewController();
  if (!presenter || !presenter.view.window) {
    reject(@"GOOGLE_NO_ACTIVITY", @"Chưa mở được cửa sổ Google. Vui lòng thử lại.", nil);
    return;
  }
  self.pendingResolve = resolve;
  self.pendingReject = reject;
  self.authInProgress = YES;
  __weak GoogleAuth *weakSelf = self;
  @try {
    GIDSignIn.sharedInstance.configuration = [[GIDConfiguration alloc] initWithClientID:clientID serverClientID:serverClientID];
    [GIDSignIn.sharedInstance signInWithPresentingViewController:presenter
        completion:^(GIDSignInResult *result, NSError *error) {
      GoogleAuth *strongSelf = weakSelf;
      if (!strongSelf || [strongSelf discardCancelledRequest]) return;
      if (error) {
        [strongSelf finishWithGoogleError:error];
        return;
      }
      if (!result.user) {
        [strongSelf finishWithToken:nil code:@"GOOGLE_EMPTY_TOKEN" message:@"Google chưa trả thông tin đăng nhập. Vui lòng thử lại."];
        return;
      }
      [result.user refreshTokensIfNeededWithCompletion:^(GIDGoogleUser *user, NSError *refreshError) {
        GoogleAuth *currentSelf = weakSelf;
        if (!currentSelf || [currentSelf discardCancelledRequest]) return;
        if (refreshError) {
          [currentSelf finishWithGoogleError:refreshError];
          return;
        }
        NSString *token = user.idToken.tokenString;
        if (!token.length) {
          [currentSelf finishWithToken:nil code:@"GOOGLE_EMPTY_TOKEN" message:@"Google chưa trả thông tin đăng nhập. Vui lòng thử lại."];
          return;
        }
        [currentSelf finishWithToken:token code:nil message:nil];
      }];
    }];
  } @catch (NSException *exception) {
    [self finishWithToken:nil code:@"GOOGLE_CONFIG" message:@"Không mở được đăng nhập Google. Vui lòng kiểm tra cấu hình iOS và cài lại ứng dụng."];
  }
}

RCT_EXPORT_METHOD(cancelSignIn) {
  RCTPromiseRejectBlock reject = self.pendingReject;
  self.pendingResolve = nil;
  self.pendingReject = nil;
  // The SDK owns its browser window. Ignore its late result instead of dismissing unrelated UI.
  // Keep authInProgress until its callback returns to prevent overlapping browser sessions.
  if (reject) reject(@"CANCELLED", @"Đã hủy đăng nhập Google.", nil);
}

RCT_EXPORT_METHOD(signOut:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  [self cancelSignIn];
  [GIDSignIn.sharedInstance signOut];
  resolve(nil);
}

- (void)invalidate {
  dispatch_async(dispatch_get_main_queue(), ^{
    self.invalidated = YES;
    [self cancelSignIn];
  });
}
@end
