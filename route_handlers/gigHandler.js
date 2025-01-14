const { QueryTypes } = require('sequelize');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const db = require('../models');

exports.createGig = catchAsync(async (req, res, next) => {
  // start the transaction

  const {
    gigType,
    gigCategory,
    gigTitle,
    gigDescription,
    minOrderAmount,
    unit,
    unitPrice,
    stock,
    sold,
    userid,
  } = req.body;

  if (
    !gigType ||
    !gigCategory ||
    !gigTitle ||
    !gigDescription ||
    !minOrderAmount ||
    !unit ||
    !unitPrice ||
    !stock ||
    !sold ||
    !userid
  ) {
    return next(new AppError('Some values missing', 400));
  }

  const t = await db.sequelize.transaction();

  try {
    // add gig details to the table
    let newGig = await db.Gig.create(
      {
        gigType,
        gigCategory,
        gigTitle,
        gigDescription,
        minOrderAmount,
        unit,
        unitPrice,
        stock,
        sold,
        gigDuration: Date.now(),
        userid,
      },
      {
        transaction: t,
      }
    );

    newGig = await newGig.save();

    // add locations to the table
    await Promise.all(
      req.body.locations.map(async (location) => {
        const newLocation = await db.Location.create(
          {
            coordinates: db.sequelize.fn(
              'ST_MakePoint',
              location.lat,
              location.lng
            ),
            gigid: newGig.dataValues.id,
          },
          {
            transaction: t,
          }
        );
        await newLocation.save();
      })
    );

    await t.commit();

    res.status(201).json({
      status: 'success',
      data: {
        user: newGig,
      },
    });
  } catch (error) {
    await t.rollback();
    return next(new AppError('Transaction failed, data not inserted', 502));
  }
});

exports.getAllGigs = catchAsync(async (req, res, next) => {
  const { location, distance } = req.body;
  let { limit } = req.body;

  if (!location || !distance) {
    return next(new AppError('Some values missing', 400));
  }

  if (!location.lat || !location.lng) {
    return next(new AppError('Latitude or Longitude missing', 400));
  }

  if (!limit) {
    limit = 10;
  }

  const query = `SELECT "Gigs"."id",
       "gigType",
       "gigCategory",
       "gigTitle",
       "gigDescription",
       "minOrderAmount",
       unit,
       "unitPrice",
       stock,
       sold,
       "gigDuration",
       "Gigs".userid                             AS "sellerId",
       "userType"                                AS "sellerType",
       json_build_object('lat', lat, 'lng', lng) AS location
FROM (SELECT DISTINCT ON ("gigid") "gigid", lat, lng
      FROM (SELECT "gigid", st_x(coordinates::geometry) as lat, st_y(coordinates::geometry) as lng
            FROM "Locations"
            WHERE ST_DWithin(coordinates,
                             ST_MakePoint(${location.lat}, ${location.lng})::geography,
                             ${distance})
            ORDER BY coordinates <-> ST_MakePoint(${location.lat}, ${location.lng})::geography
            LIMIT ${limit}) AS nearGigIds) AS distinctGigIds
         INNER JOIN "Gigs"
                    ON distinctGigIds."gigid" = "Gigs"."id"
         INNER JOIN "Users" U
                    ON U.id = "Gigs".userid
ORDER BY points;`;

  const gigs = await db.sequelize.query(query, {
    type: QueryTypes.SELECT,
  });

  res.status(200).json({
    status: 'success',
    data: {
      gigs,
    },
  });
});

exports.setLocation = catchAsync(async (req, res, next) => {
  const newLocation = await db.Location.create({
    longitude: req.body.longitude,
    latitude: req.body.latitude,
    gigId: 1,
  });

  await newLocation.save();

  res.status(201).json({
    status: 'success',
    data: {
      location: newLocation,
    },
  });
});
