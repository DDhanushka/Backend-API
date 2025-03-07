const { promisify } = require('util');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const smsKey = process.env.SMS_SECRET_KEY;

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = require('twilio')(accountSid, authToken);
const { Op } = require('sequelize');
const db = require('../models');

// const { User } = db.User;
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const sendEmail = require('../utils/email');

const refreshTokens = [];

const signToken = (phone) =>
  jwt.sign({ phone }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });

// mobile authentication
exports.sendOTP = catchAsync(async (req, res, next) => {
  const { phone } = req.body;

  if (!phone) {
    return next(new AppError('Phone number missing', 400));
  }

  const otp = Math.floor(1000 + Math.random() * 9000);
  const ttl = 2 * 60 * 1000;
  const expires = Date.now() + ttl;
  const data = `${phone}.${otp}.${expires}`;
  const hash = crypto.createHmac('sha256', smsKey).update(data).digest('hex');

  const fullHash = `${hash}.${expires}`;

  client.messages
    .create({
      body: `Your one time login password for 'GROVI' is ${otp}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
    })
    .then((message) => {
      // console.log(message);
      res.status(200).json({
        status: 'success',
        phone,
        hash: fullHash,
      });
    })
    .catch((err) => next(new AppError(err.message, err.status)));
});

exports.verifyOTP = catchAsync(async (req, res, next) => {
  const { phone, hash, otp } = req.body;
  const [hashValue, expires] = hash.split('.');

  if (!phone) {
    return next(new AppError('Please provide phone number', 400));
  }

  const now = Date.now();
  if (now > parseInt(expires, 10)) {
    return next(new AppError('OTP expired', 504));
  }

  const data = `${phone}.${otp}.${expires}`;
  const newCalculatedHash = crypto
    .createHmac('sha256', smsKey)
    .update(data)
    .digest('hex');

  if (newCalculatedHash !== hashValue) {
    return next(new AppError('Incorrect OTP', 400));
  }

  // if validation is done, search for user in the database
  const user = await db.User.findOne({
    where: {
      phone,
    },
  });

  // console.log(!!user);

  if (user) {
    // if user found immediately authenticate him
    const token = signToken(phone);
    return res.status(200).json({
      status: 'success',
      userFound: true,
      token,
      ...user,
    });
  }

  // user not found, switched to signup process, requesting signup details
  return res.status(200).json({
    status: 'success',
    userFound: false,
    phone,
  });
});

// password login
exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;

  // check email and password exits
  if (!email || !password) {
    return next(new AppError('Please provide email and password', 400));
  }

  // check if the user exists
  const user = await db.User.findOne({
    where: {
      email,
    },
    attributes: {
      exclude: ['createdAt', 'updatedAt'],
    },
  });

  // console.log(`the user is :`, user);

  // check pwd is correct
  if (!user || !(await user.correctPassword(password, user.password))) {
    return next(new AppError('Incorrect email or password', 401));
  }

  // if everything ok, send the token to client
  const token = signToken(user.phone);

  res.status(200).json({
    status: 'success',
    token,
    user: {
      userid: user.userid,
      fname: user.fname,
      lname: user.lname,
      email: user.email,
    },
  });
});

exports.signup = catchAsync(async (req, res, next) => {
  // const newUser = await createUser(req, res, next);
  const newUser = await db.User.create({
    fname: req.body.fname,
    lname: req.body.lname,
    phone: req.body.phone,
    email: req.body.email,
    password: req.body.password,
  });
  await newUser.save();

  const newCustomer = await db.Customer.create({
    userid: newUser.dataValues.id,
  });
  await newCustomer.save();

  const newConsumer = await db.Consumer.create({
    userid: newUser.dataValues.id,
  });
  await newConsumer.save();

  const newGrower = await db.Grower.create({
    userid: newUser.dataValues.id,
    ratings: req.body.ratings,
    growerType: req.body.growerType,
    gOrderCount: req.body.gOrderCount,
  });
  await newGrower.save();

  // console.log('new user - ', newUser.dataValues.id);

  const token = signToken(newUser.phone);

  res.status(201).json({
    status: 'success',
    token,
    data: {
      user: newUser,
    },
  });
});

// const authenticateUser = async (req, res, next) => {
//   const { accessToken } = req.cookies;
//
//   jwt.verify(accessToken, process.env.JWT_SECRET, async (err, phone) => {
//     if (phone) {
//       req.phone = phone;
//       next();
//     } else if (err.message === 'TokenExpiredError') {
//       return new AppError('Access token expired', 403);
//     } else {
//       console.error(err);
//       return new AppError('User not authenticated', 403);
//     }
//   });
// };

exports.refresh = catchAsync(async (req, res, next) => {
  const { refreshToken } = req.cookies;
  if (!refreshToken)
    return new AppError('Refresh token not found, please log in again', 403);
  if (!refreshTokens.includes(refreshToken))
    return new AppError('Refresh token blocked, login again', 403);

  jwt.verify(refreshToken, process.env.JWT_REFRESH_SECET, (err, phone) => {
    if (err) {
      return new AppError('Invalid refresh token', 403);
    }

    const accessToken = jwt.sign({ data: phone }, process.env.JWT_SECRET, {
      expiresIn: '30s',
    });
    res
      .status(202)
      .cookie('accessToken', accessToken, {
        expires: new Date(new Date().getTime() + 30 * 1000),
        sameSite: 'strict',
        httpOnly: true,
      })
      .cookie('authSession', true, {
        expires: new Date(new Date().getTime() + 30 * 1000),
      })
      .json({
        status: 'success',
        previousSessionExpiry: true,
      });
  });
});

exports.logout = catchAsync(async (req, res, next) => {
  res
    .clearCookie('refreshToken')
    .clearCookie('accessToken')
    .clearCookie('authSession')
    .clearCookie('refreshTokenId')
    .json({
      status: 'success',
    });
});

exports.sample = catchAsync(async (req, res, next) => {
  res.status(200).json({
    status: 'success',
    message: 'sample protected',
  });
});

exports.protect = catchAsync(async (req, res, next) => {
  // 1) Getting token and check if it's there
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access', 401)
    );
  }

  // 2) Verification token
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  // 3) Check if user if exists
  const { phone, iat } = decoded;

  const freshUser = await db.User.findOne({
    where: {
      phone,
    },
  });

  if (!freshUser) {
    return next(
      new AppError('The user belongs to this token does no longer exists', 401)
    );
  }

  // 4) Check user changes password after token was issued
  if (freshUser.changedPasswordAfter(iat)) {
    return next(
      new AppError('User recently changed password! Please log in again', 401)
    );
  }

  // GRANT ACCESS TO PROTECTED ROUTE
  req.user = freshUser;

  next();
});

exports.restrictTo =
  (...roles) =>
  (req, res, next) => {
    // roles ['admin', 'user']
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError('You do not have permission to perform this action', 403)
      );
    }

    next();
  };

exports.forgotPassword = catchAsync(async (req, res, next) => {
  // 1) Get user based on POSTed email
  const { email } = req.body;

  if (!email) {
    return next(new AppError('Please provide email', 404));
  }

  const user = await db.User.findOne({
    where: {
      email,
    },
  });

  if (!user) {
    return next(
      new AppError('There is no user with provided email address', 404)
    );
  }

  // 2) Generate random reset token
  const resetToken = user.createPasswordResetToken();
  await user.save({ validate: false });

  // 3) Send it to user's email
  // const resetURL = `${req.protocol}://${req.get(
  //   'host'
  // )}/api/v1/users/resetPassword/${resetToken}`;
  //
  // const message = `Forgot your password? Submit a PATCH request with your new password and password Confirm
  // to ${resetURL}.\nIf you didn't forget your password, please ignore this email!`;

  const message = `Enter this code in your mobile app screen ${resetToken}`;

  try {
    await sendEmail({
      email,
      subject: 'Your password reset token (valid for 10 min)',
      message,
    });
  } catch (err) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({ validate: false });

    return next(
      new AppError(
        'There was an error sending the email. Try again later!',
        500
      )
    );
  }

  res.status(200).json({
    status: 'success',
    message: 'Token sent to email',
  });
});
exports.resetPassword = catchAsync(async (req, res, next) => {
  // 1) Get user based on the token
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');

  const user = await db.User.findOne({
    where: {
      passwordResetToken: hashedToken,
      passwordResetExpires: { [Op.gt]: Date.now() },
    },
  });

  // 2) If token has not expired, and there is user, set the new password
  if (!user) {
    return next(new AppError('Token is invalid or has expired', 400));
  }

  user.password = req.body.password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  // 3) Update changedPasswordAt property for the user

  // 4) Log the user in, send JWT
  const token = signToken(user.phone);

  res.status(200).json({
    status: 'success',
    token,
  });
});
