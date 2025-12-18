const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
const port = process.env.PORT || 3000;
const admin = require('firebase-admin');

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
  'utf8'
);
const serviceAccount = JSON.parse(decoded);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// middleware
app.use(cors());
app.use(express.json());

const verifyFBToken = async (req, res, next) => {
  // console.log('headers in the middleware', req.headers.authorization);
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: 'unauthorized access' });
  }

  try {
    const idToken = token.split(' ')[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    // console.log('decoded in token', decoded);
    req.decoded_email = decoded.email;

    next();
  } catch (err) {
    return res.status(401).send({ message: 'unauthorized access' });
  }
};

const uri = process.env.MONGO_uri;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

app.get('/', (req, res) => {
  res.send('Digital Life Lessons server is running');
});

async function run() {
  // await client.connect();
  try {
    const db = client.db('DigitalLifeLessons');
    const lessonCollections = db.collection('lessonCollection');
    const userCollection = db.collection('userCollection');
    const commentCollection = db.collection('commentCollection');
    const favoriteCollection = db.collection('favoriteCollection');
    const reportCollection = db.collection('reportCollection');

    // middleware admin before allowing admin activity
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);

      if (!user || user.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' });
      }

      next();
    };

    //========================== User APIs ===============================//

    // Get all users
    app.get('/users', verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const result = await userCollection.find().toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Get user by email
    app.get('/user/:email', async (req, res) => {
      try {
        const { email } = req.params;
        const result = await userCollection.findOne({ email });
        if (!result) {
          return res.status(404).send({ message: 'User not found' });
        }
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Create or update user
    app.post('/user', async (req, res) => {
      try {
        const user = req.body;
        user.createdAt = new Date();
        const email = user.email;

        const userExists = await userCollection.findOne({ email });
        if (userExists) {
          return res.send({ message: 'user exists', user: userExists });
        }

        // Set default values
        user.isPremium = user.isPremium || false;
        user.role = user.role || 'user';

        const result = await userCollection.insertOne(user);
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Update user profile & sync lessons
    app.put('/user/:email', verifyFBToken, async (req, res) => {
      if (req.params.email !== req.decoded_email) {
        return res.status(403).send({ message: 'forbidden access' });
      }
      try {
        const { email } = req.params;
        const { displayName, photoURL, ...rest } = req.body;

        // Step 1:  Update user
        const userUpdate = await userCollection.updateOne(
          { email },
          {
            $set: {
              displayName,
              photoURL,
              ...rest,
              updatedAt: new Date(),
            },
          }
        );

        // Step 2️: Update all lessons of this user
        await lessonCollections.updateMany(
          { authorEmail: email },
          {
            $set: {
              authorName: displayName,
              authorImage: photoURL,
            },
          }
        );

        if (userUpdate.matchedCount === 0) {
          return res.status(404).send({ message: 'User not found' });
        }

        const updatedUser = await userCollection.findOne({ email });

        res.send({
          message: 'Profile & lessons updated successfully',
          user: updatedUser,
        });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Update user premium status
    app.patch('/user/premium/:email', verifyFBToken, async (req, res) => {
      try {
        const { email } = req.params;
        const { isPremium } = req.body;

        const result = await userCollection.updateOne(
          { email },
          { $set: { isPremium: isPremium, updatedAt: new Date() } }
        );

        if (result.modifiedCount > 0) {
          res.send({ message: 'User premium status updated successfully' });
        } else {
          res.status(404).send({ message: 'User not found' });
        }
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Get top contributors
    app.get('/users/top-contributors', async (req, res) => {
      try {
        const result = await lessonCollections
          .aggregate([
            { $match: { privacy: 'Public' } },
            {
              $group: {
                _id: '$authorEmail',
                lessonsCount: { $sum: 1 },
                totalViews: { $sum: '$views' },
                totalLikes: { $sum: '$likesCount' },
                name: { $first: '$authorName' },
                image: { $first: '$authorImage' },
                email: { $first: '$authorEmail' },
              },
            },
            { $sort: { lessonsCount: -1 } },
            { $limit: 10 },
          ])
          .toArray();

        for (let contributor of result) {
          const user = await userCollection.findOne({
            email: contributor.email,
          });
          contributor.isPremium = user?.isPremium || false;
        }

        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    //========================== Lesson APIs =================================//

    // Get all lessons with filters
    app.get('/lessons', verifyFBToken, async (req, res) => {
      try {
        const { email } = req.query;
        const query = {};

        if (email) {
          query.authorEmail = email;
          if (email !== req.decoded_email) {
            return res.status(403).send({ message: 'forbidden access' });
          }
        }

        const result = await lessonCollections
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Get public lessons with search, filter, and sort
    app.get('/lessons/public', async (req, res) => {
      try {
        const {
          category,
          emotion,
          search,
          sort = 'newest',
          page = 1,
          limit = 20,
        } = req.query;

        let query = { privacy: 'Public' };

        if (category && category !== 'All') {
          query.category = category;
        }
        if (emotion && emotion !== 'All') {
          query.emotion = emotion;
        }
        if (search) {
          query.$or = [
            { title: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } },
          ];
        }

        let sortOrder = { createdAt: -1 };
        switch (sort) {
          case 'oldest':
            sortOrder = { createdAt: 1 };
            break;
          case 'mostViewed':
            sortOrder = { views: -1 };
            break;
          case 'mostSaved':
            sortOrder = { favoritesCount: -1 };
            break;
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const result = await lessonCollections
          .find(query)
          .sort(sortOrder)
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Get featured lessons
    app.get('/lessons/featured', async (req, res) => {
      try {
        const result = await lessonCollections
          .find({ isFeatured: true, privacy: 'Public' })
          .sort({ createdAt: -1 })
          .limit(6)
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Get most saved lessons
    app.get('/lessons/most-saved', async (req, res) => {
      try {
        const result = await lessonCollections
          .find({ privacy: 'Public' })
          .sort({ favoritesCount: -1 })
          .limit(6)
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Get user's lessons
    app.get('/lessons/user/:email', async (req, res) => {
      try {
        const { email } = req.params;
        const result = await lessonCollections
          .find({ authorEmail: email })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Get similar lessons

    app.get('/lessons/similar', async (req, res) => {
      try {
        const { category, emotion, exclude } = req.query;

        if (!category || !emotion) {
          return res
            .status(400)
            .json({ message: 'category and emotion are required' });
        }

        const query = {
          category,
          emotion,
        };

        console.log(query._id);

        if (exclude && exclude.trim() !== '') {
          if (ObjectId.isValid(exclude) && exclude.length === 24) {
            query._id = { $ne: new ObjectId(exclude) };
          } else {
            return res.status(400).json({
              message:
                'Invalid exclude ID format. Must be a 24 character hex string.',
            });
          }
        }

        const lessons = await lessonCollections.find(query).limit(6).toArray();

        res.json(lessons);
      } catch (error) {
        console.error('Error fetching similar lessons:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
      }
    });

    // Get lesson by ID
    app.get('/lessons/:id', async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: 'Invalid Lesson ID format' });
        }

        const result = await lessonCollections.findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $inc: { views: 1 } },
          { returnDocument: 'after' }
        );

        const lesson = result.value || result;

        if (!lesson) {
          return res.status(404).send({ message: 'Lesson not found' });
        }

        res.send(lesson);
      } catch (error) {
        console.error('Error in GET /lessons/:id:', error);
        res.status(500).send({ error: error.message });
      }
    });

    // Create lesson
    app.post('/lessons', async (req, res) => {
      try {
        const lesson = req.body;
        lesson.createdAt = new Date();
        lesson.views = 0;
        lesson.likesCount = 0;
        lesson.favoritesCount = 0;
        lesson.likes = [];
        lesson.isFeatured = false;

        const result = await lessonCollections.insertOne(lesson);
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Update lesson by ID
    app.put('/lessons/:id', verifyFBToken, async (req, res) => {
      try {
        const { id } = req.params;
        const updateData = req.body;
        updateData.updatedAt = new Date();

        const filter = { _id: new ObjectId(id) };
        const updateDoc = { $set: updateData };

        const result = await lessonCollections.updateOne(filter, updateDoc);
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Update lesson privacy
    app.patch('/lessons/privacy/:id', verifyFBToken, async (req, res) => {
      try {
        const { id } = req.params;
        const { privacy } = req.body;

        const result = await lessonCollections.updateOne(
          { _id: new ObjectId(id) },
          { $set: { privacy, updatedAt: new Date() } }
        );

        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Update lesson access level
    app.patch('/lessons/access/:id', verifyFBToken, async (req, res) => {
      try {
        const { id } = req.params;
        const { accessLevel } = req.body;

        const result = await lessonCollections.updateOne(
          { _id: new ObjectId(id) },
          { $set: { accessLevel, updatedAt: new Date() } }
        );

        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Delete lesson by ID
    app.delete('/lessons/:id', verifyFBToken, async (req, res) => {
      try {
        const { id } = req.params;
        const query = { _id: new ObjectId(id) };

        await commentCollection.deleteMany({ lessonId: new ObjectId(id) });
        await favoriteCollection.deleteMany({ lessonId: new ObjectId(id) });

        const result = await lessonCollections.deleteOne(query);
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Like lesson
    app.post('/lessons/:id/like', verifyFBToken, async (req, res) => {
      try {
        const { id } = req.params;
        const { userId } = req.body;

        const lesson = await lessonCollections.findOne({
          _id: new ObjectId(id),
        });

        if (!lesson) {
          return res.status(404).send({ message: 'Lesson not found' });
        }

        const likes = lesson.likes || [];
        const isLiked = likes.includes(userId);

        let updateOperation;
        if (isLiked) {
          updateOperation = {
            $pull: { likes: userId },
            $inc: { likesCount: -1 },
          };
        } else {
          updateOperation = {
            $addToSet: { likes: userId },
            $inc: { likesCount: 1 },
          };
        }

        const result = await lessonCollections.updateOne(
          { _id: new ObjectId(id) },
          updateOperation
        );

        res.send({ success: true, isLiked: !isLiked });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    //========================== Comment APIs ====================================//

    // Get lesson comments
    app.get('/lessons/:id/comments', async (req, res) => {
      try {
        const { id } = req.params;
        const result = await commentCollection
          .find({ lessonId: new ObjectId(id) })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Add comment
    app.post('/lessons/:id/comments', verifyFBToken, async (req, res) => {
      try {
        const { id } = req.params;
        const comment = req.body;
        comment.lessonId = new ObjectId(id);
        comment.createdAt = new Date();

        const result = await commentCollection.insertOne(comment);
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    //========================== Favorite APIs ===================================//

    // Add to favorites
    app.post('/lessons/:id/favorite', verifyFBToken, async (req, res) => {
      try {
        const { id } = req.params;
        const { userId, userEmail } = req.body;

        // Check if already favorite
        const existingFavorite = await favoriteCollection.findOne({
          lessonId: new ObjectId(id),
          userEmail: userEmail,
        });

        if (existingFavorite) {
          return res.send({ message: 'Already favorite' });
        }

        // Get lesson details
        const lesson = await lessonCollections.findOne({
          _id: new ObjectId(id),
        });

        const favorite = {
          lessonId: new ObjectId(id),
          userEmail: userEmail,
          lesson: lesson,
          createdAt: new Date(),
        };

        const result = await favoriteCollection.insertOne(favorite);

        // Increment favorites count in lesson
        await lessonCollections.updateOne(
          { _id: new ObjectId(id) },
          { $inc: { favoritesCount: 1 } }
        );

        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Get user's favorites
    app.get('/favorites/user/:email', verifyFBToken, async (req, res) => {
      try {
        const { email } = req.params;
        const result = await favoriteCollection
          .find({ userEmail: email })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Remove from favorites
    app.delete('/favorites/:lessonId', verifyFBToken, async (req, res) => {
      try {
        const { lessonId } = req.params;
        const { userEmail } = req.body;

        const result = await favoriteCollection.deleteOne({
          lessonId: new ObjectId(lessonId),
          userEmail: userEmail,
        });

        await lessonCollections.updateOne(
          { _id: new ObjectId(lessonId) },
          { $inc: { favoritesCount: -1 } }
        );

        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    //========================== Report APIs ====================================//

    // Report lesson
    app.post('/lessons/report', verifyFBToken, async (req, res) => {
      try {
        const report = req.body;
        report.createdAt = new Date();

        const result = await reportCollection.insertOne(report);
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    //========================== Payment APIs ===================================//

    app.post('/create-checkout-session', async (req, res) => {
      try {
        const paymentInfo = req.body;
        // console.log(paymentInfo)

        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: 'usd',
                product_data: {
                  name: 'Life Lessons Premium Membership',
                  description: 'Lifetime access to all premium features',
                },
                unit_amount: 1500,
              },
              quantity: 1,
            },
          ],
          customer_email: paymentInfo.authorEmail,
          mode: 'payment',
          success_url: `${process.env.SITE_DOMAIN}/dashboard/payment_success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.SITE_DOMAIN}/payment/payment-cancelled`,
        });

        // console.log(session)

        res.send({ url: session.url });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // payment success
    app.patch('/payment_success', async (req, res) => {
      try {
        const sessionId = req.query.session_id;
        if (!sessionId)
          return res.status(400).send({ error: 'session_id is required' });

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        // console.log(session);

        if (session.payment_status === 'paid') {
          const email = session.customer_email;
          if (!email)
            return res
              .status(400)
              .send({ error: 'No customer email found in session' });

          const result = await userCollection.updateOne(
            { email: email },
            { $set: { isPremium: true, updatedAt: new Date() } }
          );

          if (result.modifiedCount > 0) {
            return res.send({
              success: true,
              message: 'User upgraded to premium',
            });
          } else {
            return res
              .status(404)
              .send({ success: false, message: 'User not found' });
          }
        } else {
          return res
            .status(400)
            .send({ success: false, message: 'Payment not completed' });
        }
      } catch (error) {
        console.error(error);
        res.status(500).send({ error: error.message });
      }
    });

    //========================== Admin APIs ====================================//

    // Get all lessons (Admin)
    app.get('/admin/lessons', verifyFBToken, async (req, res) => {
      try {
        const result = await lessonCollections
          .find()
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Toggle featured status (Admin)
    app.patch(
      '/admin/lessons/:id/featured',
      verifyFBToken,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { isFeatured } = req.body;

          const result = await lessonCollections.updateOne(
            { _id: new ObjectId(id) },
            { $set: { isFeatured, updatedAt: new Date() } }
          );

          res.send(result);
        } catch (error) {
          res.status(500).send({ error: error.message });
        }
      }
    );

    // Get reported lessons (Admin)
    app.get(
      '/admin/reported-lessons',
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const result = await reportCollection
            .aggregate([
              {
                $lookup: {
                  from: 'lessonCollection',
                  localField: 'lessonId',
                  foreignField: '_id',
                  as: 'lesson',
                },
              },
              {
                $group: {
                  _id: '$lessonId',
                  reportCount: { $sum: 1 },
                  reports: { $push: '$$ROOT' },
                  lesson: { $first: { $arrayElemAt: ['$lesson', 0] } },
                },
              },
              { $sort: { reportCount: -1 } },
            ])
            .toArray();

          res.send(result);
        } catch (error) {
          res.status(500).send({ error: error.message });
        }
      }
    );

    // Update user role (Admin)
    app.patch(
      '/admin/users/:email/role',
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { email } = req.params;
          const { role } = req.body;

          const result = await userCollection.updateOne(
            { email },
            { $set: { role, updatedAt: new Date() } }
          );

          if (result.modifiedCount > 0) {
            res.send({ message: 'User role updated successfully' });
          } else {
            res.status(404).send({ message: 'User not found' });
          }
        } catch (error) {
          res.status(500).send({ error: error.message });
        }
      }
    );

    // Ignore lesson (Admin)
    app.patch(
      '/admin/reported-lessons/:lessonId/ignore',
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { lessonId } = req.params;

          const result = await reportCollection.updateMany(
            { lessonId: new ObjectId(lessonId), resolved: { $ne: true } },
            {
              $set: {
                resolved: true,
                action: 'ignored',
                resolvedAt: new Date(),
              },
            }
          );

          res.send({ success: true, message: 'Reports ignored, lesson kept' });
        } catch (error) {
          res.status(500).send({ error: error.message });
        }
      }
    );

    // Delete lesson (Admin)
    app.delete(
      '/admin/reported-lessons/:lessonId',
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { lessonId } = req.params;

          // Delete lesson
          const lessonResult = await lessonCollections.deleteOne({
            _id: new ObjectId(lessonId),
          });

          // Delete all associated reports
          const reportResult = await reportCollection.deleteMany({
            lessonId: new ObjectId(lessonId),
          });

          res.send({
            success: true,
            message: 'Lesson and all reports deleted successfully',
            lessonDeleted: lessonResult.deletedCount,
            reportsDeleted: reportResult.deletedCount,
          });
        } catch (error) {
          res.status(500).send({ error: error.message });
        }
      }
    );

    // await client.db('admin').command({ ping: 1 });
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    );
  } finally {
    // await client.close();
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`Digital Life Lessons is running on port: ${port}`);
});
